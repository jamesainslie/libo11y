package redact_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/jamesainslie/libo11y/go/redact"
)

func logToJSON(t *testing.T, attrs ...any) map[string]any {
	t.Helper()
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	logger.Info("event", attrs...)
	var m map[string]any
	if err := json.Unmarshal(buf.Bytes(), &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return m
}

func logJSONString(t *testing.T, attrs ...any) string {
	t.Helper()
	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("event", attrs...)
	return buf.String()
}

func TestSecretRendersRedactedEverywhere(t *testing.T) {
	secret := redact.NewSecret("hunter2")

	if got := fmt.Sprintf("%v", secret); got != redact.Redacted {
		t.Errorf("%%v = %q, want %q", got, redact.Redacted)
	}
	if got := fmt.Sprintf("token=%s", secret); got != "token="+redact.Redacted {
		t.Errorf("%%s = %q, want token=%q", got, redact.Redacted)
	}
	if got := fmt.Sprintf("%#v", secret); got != redact.Redacted {
		t.Errorf("%%#v = %q, want %q", got, redact.Redacted)
	}

	encoded, err := json.Marshal(secret)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	if got := string(encoded); got != `"REDACTED"` {
		t.Errorf("json = %s, want \"REDACTED\"", got)
	}

	record := logToJSON(t, "password", secret)
	if got := record["password"]; got != redact.Redacted {
		t.Errorf("slog = %v, want %q", got, redact.Redacted)
	}

	if got := secret.Reveal(); got != "hunter2" {
		t.Errorf("Reveal = %q, want the original value", got)
	}
}

func TestMaskedCountsRunesNotBytes(t *testing.T) {
	name := redact.Masked("Jürgen") // 6 runes, 7 bytes
	if got, want := fmt.Sprint(name), "XXXXXX"; got != want {
		t.Errorf("masked = %q, want %q (rune count, not byte count)", got, want)
	}
}

func TestMaskedPreservesShapeOnly(t *testing.T) {
	card := redact.Masked("4111111111111111")

	want := strings.Repeat("X", 16)
	if got := fmt.Sprint(card); got != want {
		t.Errorf("fmt = %q, want %q", got, want)
	}
	record := logToJSON(t, "card", card)
	if got := record["card"]; got != want {
		t.Errorf("slog = %v, want %q", got, want)
	}
	encoded, err := json.Marshal(card)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	if got := string(encoded); got != `"`+want+`"` {
		t.Errorf("json = %s, want %q", got, want)
	}
}

type payment struct {
	Card     string `o11y:"mask"`
	CVV      string `o11y:"redact"`
	PIN      string `o11y:"omit"`
	Merchant string
	internal string //nolint:unused // exercises unexported-field omission
}

func TestStructTagProtections(t *testing.T) {
	p := payment{
		Card:     "4111111111111111",
		CVV:      "123",
		PIN:      "9876",
		Merchant: "ACME",
		internal: "state",
	}
	record := logToJSON(t, "payment", redact.Struct(p))
	group, ok := record["payment"].(map[string]any)
	if !ok {
		t.Fatalf("payment group missing: %v", record)
	}

	if got, want := group["Card"], strings.Repeat("X", 16); got != want {
		t.Errorf("Card = %v, want %v", got, want)
	}
	if got := group["CVV"]; got != redact.Redacted {
		t.Errorf("CVV = %v, want %v", got, redact.Redacted)
	}
	if _, present := group["PIN"]; present {
		t.Error("PIN present despite omit tag")
	}
	if _, present := group["internal"]; present {
		t.Error("unexported field leaked")
	}
	if got := group["Merchant"]; got != "ACME" {
		t.Errorf("Merchant = %v, want ACME", got)
	}
}

type account struct {
	Owner   string
	Payment payment `o11y:"redact"`
}

func TestStrictestWinsThroughNesting(t *testing.T) {
	a := account{
		Owner: "gopher",
		Payment: payment{
			Card:     "4111111111111111",
			Merchant: "ACME",
		},
	}
	record := logToJSON(t, "account", redact.Struct(a))
	group, ok := record["account"].(map[string]any)
	if !ok {
		t.Fatalf("account group missing: %v", record)
	}
	// The redact floor collapses the entire nested struct to REDACTED;
	// nothing inside it may leak, not even the passthrough Merchant.
	if got := group["Payment"]; got != redact.Redacted {
		t.Errorf("Payment = %v, want %v", got, redact.Redacted)
	}
	if got := group["Owner"]; got != "gopher" {
		t.Errorf("Owner = %v, want gopher", got)
	}
}

type maskedTree struct {
	Inner leaf `o11y:"mask"`
}

type leaf struct {
	Name string
}

func TestMaskFloorMasksNestedLeaves(t *testing.T) {
	record := logToJSON(t, "tree", redact.Struct(maskedTree{Inner: leaf{Name: "value"}}))
	group := record["tree"].(map[string]any)
	inner, ok := group["Inner"].(map[string]any)
	if !ok {
		t.Fatalf("Inner group missing: %v", group)
	}
	if got, want := inner["Name"], "XXXXX"; got != want {
		t.Errorf("Inner.Name = %v, want %v (masked leaf)", got, want)
	}
}

type badTag struct {
	Field string `o11y:"encrypt"` // not a supported protection
}

func TestUnknownTagFailsClosed(t *testing.T) {
	record := logToJSON(t, "v", redact.Struct(badTag{Field: "sensitive"}))
	group := record["v"].(map[string]any)
	if got := group["Field"]; got != redact.Redacted {
		t.Errorf("unknown tag rendered %v, want %v (fail closed)", got, redact.Redacted)
	}
}

func TestStructWithPointerAndNil(t *testing.T) {
	p := &payment{Card: "4111", Merchant: "ACME"}
	record := logToJSON(t, "payment", redact.Struct(p))
	if _, ok := record["payment"].(map[string]any); !ok {
		t.Errorf("pointer to struct did not render as group: %v", record)
	}

	record = logToJSON(t, "payment", redact.Struct((*payment)(nil)))
	if got := record["payment"]; got != nil {
		t.Errorf("nil pointer rendered %v, want null", got)
	}
}

func TestStructOnNonStructPassesThrough(t *testing.T) {
	record := logToJSON(t, "n", redact.Struct(42))
	if got := record["n"]; got != float64(42) {
		t.Errorf("non-struct = %v, want 42", got)
	}
}

type order struct {
	ID    string
	Items []payment
}

// TestSliceOfTaggedStructsProtected pins the fix for the container leak:
// every element of a slice/array/map of tagged structs must be protected.
func TestSliceOfTaggedStructsProtected(t *testing.T) {
	o := order{ID: "o-1", Items: []payment{
		{Card: "4111111111111111", CVV: "123", PIN: "9876", Merchant: "ACME"},
	}}
	line := logJSONString(t, "order", redact.Struct(o))
	for _, secret := range []string{"4111111111111111", "123", "9876"} {
		if strings.Contains(line, secret) {
			t.Errorf("slice element leaked %q in: %s", secret, line)
		}
	}
	if !strings.Contains(line, "ACME") {
		t.Errorf("passthrough field lost: %s", line)
	}
}

type walletByName struct {
	Cards map[string]payment
}

func TestMapOfTaggedStructsProtected(t *testing.T) {
	w := walletByName{Cards: map[string]payment{
		"primary": {Card: "4111111111111111", CVV: "123", PIN: "9876"},
	}}
	line := logJSONString(t, "wallet", redact.Struct(w))
	for _, secret := range []string{"4111111111111111", "123", "9876"} {
		if strings.Contains(line, secret) {
			t.Errorf("map value leaked %q in: %s", secret, line)
		}
	}
}

type arrayHolder struct {
	Items [1]payment
}

func TestArrayOfTaggedStructsProtected(t *testing.T) {
	h := arrayHolder{Items: [1]payment{{Card: "4111111111111111", CVV: "123", PIN: "9876"}}}
	line := logJSONString(t, "h", redact.Struct(h))
	for _, secret := range []string{"4111111111111111", "123", "9876"} {
		if strings.Contains(line, secret) {
			t.Errorf("array element leaked %q in: %s", secret, line)
		}
	}
}

type anyHolder struct {
	Payload any
}

func TestInterfaceFieldOfTaggedStructsProtected(t *testing.T) {
	h := anyHolder{Payload: []payment{{Card: "4111111111111111", CVV: "123", PIN: "9876"}}}
	line := logJSONString(t, "h", redact.Struct(h))
	for _, secret := range []string{"4111111111111111", "123", "9876"} {
		if strings.Contains(line, secret) {
			t.Errorf("interface-held slice leaked %q in: %s", secret, line)
		}
	}
}

type selfProtected struct{ APIKey string }

func (s selfProtected) LogValue() slog.Value { return slog.StringValue(redact.Redacted) }

type configWithSelfProtected struct {
	Auth selfProtected
}

// TestNestedLogValuerHonored pins the fix for the LogValuer-bypass leak: a
// nested self-protecting type must keep its protection inside Struct.
func TestNestedLogValuerHonored(t *testing.T) {
	line := logJSONString(t, "config", redact.Struct(configWithSelfProtected{
		Auth: selfProtected{APIKey: "sk-live-secret"},
	}))
	if strings.Contains(line, "sk-live-secret") {
		t.Errorf("nested LogValuer bypassed, leaked in: %s", line)
	}
}

type secretHolder struct {
	Token redact.Secret[string]
}

func TestNestedSecretHonored(t *testing.T) {
	line := logJSONString(t, "h", redact.Struct(secretHolder{Token: redact.NewSecret("sk-live-xyz")}))
	if strings.Contains(line, "sk-live-xyz") {
		t.Errorf("nested Secret leaked in: %s", line)
	}
}

type cyclic struct {
	Name string
	Next *cyclic
}

// TestCyclicGraphDoesNotCrash pins the fix for the stack-overflow DoS: a
// cyclic structure must render (bounded) rather than recurse forever.
func TestCyclicGraphDoesNotCrash(t *testing.T) {
	node := &cyclic{Name: "a"}
	node.Next = node
	line := logJSONString(t, "node", redact.Struct(node))
	if line == "" {
		t.Error("cyclic render produced no output")
	}
}

type taggedAxes struct {
	Token string `o11y:"secret"`
	Name  string `o11y:"confidential"`
}

// TestStructSecretTagRedacts pins the two-axis vocabulary: a secret-tagged
// field renders REDACTED (never its value), the fail-closed backstop for the
// strictest classification.
func TestStructSecretTagRedacts(t *testing.T) {
	v := redact.Struct(taggedAxes{Token: "abc", Name: "gopher"}).LogValue()
	if strings.Contains(fmt.Sprint(v), "abc") {
		t.Fatalf("secret-tagged field leaked: %v", v)
	}
}

// TestStructConfidentialTagMasks pins that a confidential-tagged field masks
// (preserving shape only) rather than redacting or passing through.
func TestStructConfidentialTagMasks(t *testing.T) {
	record := logToJSON(t, "v", redact.Struct(taggedAxes{Token: "abc", Name: "gopher"}))
	group := record["v"].(map[string]any)
	if got, want := group["Name"], strings.Repeat("X", 6); got != want {
		t.Errorf("confidential Name = %v, want %v (masked)", got, want)
	}
	if got := group["Token"]; got != redact.Redacted {
		t.Errorf("secret Token = %v, want %v (redacted)", got, redact.Redacted)
	}
}

func TestSecretNumericVerbsRedacted(t *testing.T) {
	secret := redact.NewSecret(4242)
	for _, verb := range []string{"%d", "%o", "%b", "%+d", "%v", "%s"} {
		if got := fmt.Sprintf(verb, secret); got != redact.Redacted {
			t.Errorf("verb %s = %q, want %q", verb, got, redact.Redacted)
		}
	}
}

func TestMaskedNumericVerbRedacted(t *testing.T) {
	card := redact.Masked("4111111111111111")
	want := strings.Repeat("X", 16)
	for _, verb := range []string{"%d", "%v", "%s"} {
		got := fmt.Sprintf(verb, card)
		if strings.Contains(got, "4111") {
			t.Errorf("verb %s leaked raw value: %q", verb, got)
		}
		if verb != "%d" && got != want {
			t.Errorf("verb %s = %q, want %q", verb, got, want)
		}
	}
}

type intValuer struct{}

func (intValuer) LogValue() slog.Value { return slog.Int64Value(8675309) }

type groupValuer struct{}

func (groupValuer) LogValue() slog.Value {
	return slog.GroupValue(slog.String("token", "tok-raw-123"), slog.Int64("n", 4242424242))
}

type anyValuer struct{}

func (anyValuer) LogValue() slog.Value {
	return slog.AnyValue(map[string]string{"k": "raw-map-secret"})
}

type nestedSecretValuer struct{}

func (nestedSecretValuer) LogValue() slog.Value {
	return slog.GroupValue(slog.Any("s", redact.NewSecret("inner-secret")))
}

func TestMaskFloorAppliesToAllResolvedKinds(t *testing.T) {
	type holder struct {
		Num    intValuer          `o11y:"mask"`
		Grp    groupValuer        `o11y:"confidential"`
		Any    anyValuer          `o11y:"mask"`
		Nested nestedSecretValuer `o11y:"mask"`
	}
	for name, newHandler := range map[string]func(io.Writer) slog.Handler{
		"json": func(w io.Writer) slog.Handler { return slog.NewJSONHandler(w, nil) },
		"text": func(w io.Writer) slog.Handler { return slog.NewTextHandler(w, nil) },
	} {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			slog.New(newHandler(&buf)).Info("m", "v", redact.Struct(holder{}))
			out := buf.String()
			for _, raw := range []string{"8675309", "tok-raw-123", "4242424242", "raw-map-secret", "inner-secret"} {
				if strings.Contains(out, raw) {
					t.Errorf("raw value %q leaked under a mask floor: %s", raw, out)
				}
			}
			if !strings.Contains(out, redact.Redacted) {
				t.Errorf("nested Secret lost its stricter REDACTED protection: %s", out)
			}
		})
	}
}

// TestStructSelfReferentialInterfaceTerminates runs the cycle in a child
// test process killed on timeout, so a regression cannot leave a spinning
// goroutine in this process.
func TestStructSelfReferentialInterfaceTerminates(t *testing.T) {
	if os.Getenv("REDACT_CYCLE_CHILD") == "1" {
		var v any
		v = &v
		got := redact.Struct(v).LogValue().String()
		if !strings.Contains(got, redact.Redacted) {
			t.Fatalf("cycle rendered %q, want REDACTED", got)
		}
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestStructSelfReferentialInterfaceTerminates$", "-test.count=1")
	cmd.Env = append(os.Environ(), "REDACT_CYCLE_CHILD=1")
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("pointer/interface cycle did not terminate within 20s (child killed)")
	}
	if err != nil {
		t.Fatalf("child failed: %v\n%s", err, out)
	}
}

func TestStructNilAndDeepPointerChains(t *testing.T) {
	if got := redact.Struct(nil).LogValue(); got.Any() != nil {
		t.Errorf("Struct(nil) = %v, want nil value", got)
	}
	var typedNil *struct{ A string }
	if got := redact.Struct(typedNil).LogValue(); got.Any() != nil {
		t.Errorf("Struct(typed nil) = %v, want nil value", got)
	}
	chain := func(n int) any {
		var v any = "leaf"
		for range n {
			x := v
			v = &x
		}
		return v
	}
	if got := redact.Struct(chain(3)).LogValue().String(); got != "leaf" {
		t.Errorf("shallow chain = %q, want leaf", got)
	}
	if got := redact.Struct(chain(40)).LogValue().String(); got != redact.Redacted {
		t.Errorf("deep chain = %q, want %s", got, redact.Redacted)
	}
}

func TestMaskFloorProtectsMapKeys(t *testing.T) {
	type holder struct {
		Emails map[string]int `o11y:"mask"`
		Plain  map[string]int
	}
	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("m", "v", redact.Struct(holder{
		Emails: map[string]int{"alice@example.com": 1, "bob@example.com": 2},
		Plain:  map[string]int{"b": 2, "a": 1},
	}))
	out := buf.String()
	for _, raw := range []string{"alice@example.com", "bob@example.com"} {
		if strings.Contains(out, raw) {
			t.Errorf("masked map key %q leaked: %s", raw, out)
		}
	}
	if !strings.Contains(out, `"Plain":{"a":"1","b":"2"}`) && !strings.Contains(out, `"Plain":{"a":1,"b":2}`) {
		t.Errorf("unmasked map should render sorted by key: %s", out)
	}
}

func TestStructRendersOpaqueLeafTypes(t *testing.T) {
	when := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	type holder struct {
		At     time.Time
		IP     net.IP
		Masked net.IP `o11y:"mask"`
	}
	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("m", "v", redact.Struct(holder{
		At: when, IP: net.ParseIP("10.1.2.3"), Masked: net.ParseIP("10.9.9.9"),
	}))
	out := buf.String()
	if !strings.Contains(out, `"At":"2026-10-11T12:00:00Z"`) {
		t.Errorf("time.Time not rendered as text: %s", out)
	}
	if !strings.Contains(out, `"IP":"10.1.2.3"`) {
		t.Errorf("net.IP not rendered as text: %s", out)
	}
	if strings.Contains(out, "10.9.9.9") || !strings.Contains(out, `"Masked":"XXXXXXXX"`) {
		t.Errorf("masked net.IP not masked as text: %s", out)
	}
}

func TestStructTaggedTextMarshalerStillWalksFields(t *testing.T) {
	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("m", "v", redact.Struct(taggedMarshaler{Token: "raw-token"}))
	if strings.Contains(buf.String(), "raw-token") {
		t.Errorf("tagged field leaked through MarshalText: %s", buf.String())
	}
}

type taggedMarshaler struct {
	Token string `o11y:"secret"`
}

func (t taggedMarshaler) MarshalText() ([]byte, error) { return []byte("token=" + t.Token), nil }

// EmbeddedCreds is exported so that embedding it yields an exported field.
type EmbeddedCreds struct {
	Token string `o11y:"secret"`
}

func (c EmbeddedCreds) String() string { return "token=" + c.Token }

// reqEmbed inherits String from EmbeddedCreds through embedding.
type reqEmbed struct {
	EmbeddedCreds
	ID string
}

type authInfo struct {
	Token string `o11y:"secret"`
}

type outerStringer struct {
	ID   string
	Auth authInfo
}

func (o outerStringer) String() string { return o.ID + ":" + o.Auth.Token }

type leakUser struct {
	Name     string
	Password string `o11y:"secret"`
}

type leakUsers []leakUser

func (u leakUsers) String() string {
	parts := make([]string, len(u))
	for i, user := range u {
		parts[i] = user.Name + "/" + user.Password
	}
	return strings.Join(parts, ",")
}

type hiddenToken struct {
	ID    string
	token string `o11y:"secret"`
}

func (h hiddenToken) String() string { return h.ID + ":" + h.token }

func TestTextLeafDoesNotBypassNestedTags(t *testing.T) {
	cases := map[string]any{
		"embedded tagged struct with promoted String": reqEmbed{EmbeddedCreds: EmbeddedCreds{Token: "raw-embed-tok"}, ID: "r1"},
		"Stringer with tagged nested field":           outerStringer{ID: "o1", Auth: authInfo{Token: "raw-outer-tok"}},
		"named slice Stringer of tagged elements":     leakUsers{{Name: "u1", Password: "raw-user-pw"}},
		"Stringer with unexported tagged field":       hiddenToken{ID: "h1", token: "raw-hidden-tok"},
	}
	for name, v := range cases {
		t.Run(name, func(t *testing.T) {
			out := logJSONString(t, "v", redact.Struct(v))
			if strings.Contains(out, "raw-") {
				t.Errorf("nested tagged value leaked through text form: %s", out)
			}
		})
	}
}

func TestMaskFloorDoesNotLeakNestedSecretLength(t *testing.T) {
	type holder struct {
		O outerStringer `o11y:"mask"`
	}
	out := logJSONString(t, "v", redact.Struct(holder{O: outerStringer{ID: "o1", Auth: authInfo{Token: "raw-outer-tok"}}}))
	if strings.Contains(out, "raw-outer-tok") {
		t.Fatalf("raw token leaked: %s", out)
	}
	if !strings.Contains(out, `"Token":"REDACTED"`) {
		t.Errorf("nested secret under a mask floor should render REDACTED, not fold into a masked string: %s", out)
	}
}

func TestStructRendersNetipAddrAsText(t *testing.T) {
	type holder struct {
		Addr netip.Addr
	}
	out := logJSONString(t, "v", redact.Struct(holder{Addr: netip.MustParseAddr("192.0.2.7")}))
	if !strings.Contains(out, `"Addr":"192.0.2.7"`) {
		t.Errorf("netip.Addr not rendered as text: %s", out)
	}
}

type plainNode struct {
	Name string
	Next *plainNode
}

func (n plainNode) String() string { return "node:" + n.Name }

type taggedNode struct {
	Name   string
	Secret string `o11y:"secret"`
	Next   *taggedNode
}

func (n taggedNode) String() string { return n.Name + ":" + n.Secret }

func TestRecursiveTypeScanTerminatesAndHonorsTags(t *testing.T) {
	out := logJSONString(t, "plain", redact.Struct(plainNode{Name: "a", Next: &plainNode{Name: "b"}}),
		"tagged", redact.Struct(taggedNode{Name: "t", Secret: "raw-node-secret", Next: &taggedNode{Name: "u"}}))
	if !strings.Contains(out, `"plain":"node:a"`) {
		t.Errorf("untagged recursive Stringer should render as text: %s", out)
	}
	if strings.Contains(out, "raw-node-secret") {
		t.Errorf("tagged recursive Stringer leaked: %s", out)
	}
}

type taggedPayload struct {
	User  string
	Token string `o11y:"secret"`
}

type anyTaggedValuer struct{}

func (anyTaggedValuer) LogValue() slog.Value {
	return slog.AnyValue(taggedPayload{User: "u", Token: "raw-valuer-tok"})
}

type groupTaggedValuer struct{}

func (groupTaggedValuer) LogValue() slog.Value {
	return slog.GroupValue(
		slog.Any("p", taggedPayload{User: "u", Token: "raw-group-tok"}),
		slog.Int("n", 7),
	)
}

func TestPassthroughLogValuerResultIsWalked(t *testing.T) {
	type holder struct {
		A anyTaggedValuer
		G groupTaggedValuer
	}
	out := logJSONString(t,
		"field", redact.Struct(holder{}),
		"top", redact.Struct(anyTaggedValuer{}),
	)
	for _, raw := range []string{"raw-valuer-tok", "raw-group-tok"} {
		if strings.Contains(out, raw) {
			t.Errorf("tagged value returned by a LogValuer leaked %q: %s", raw, out)
		}
	}
	if !strings.Contains(out, `"n":7`) {
		t.Errorf("passthrough scalars returned by a LogValuer should stay unchanged: %s", out)
	}
	if !strings.Contains(out, `"User":"u"`) {
		t.Errorf("untagged fields of a LogValuer result should still render: %s", out)
	}
}

type taggedKey struct {
	ID    string
	Token string `o11y:"secret"`
}

func TestMapKeysWithTaggedTypesFailClosed(t *testing.T) {
	type holder struct {
		ByKey map[taggedKey]int
		ByAny map[any]int
	}
	out := logJSONString(t, "v", redact.Struct(holder{
		ByKey: map[taggedKey]int{{ID: "k1", Token: "raw-key-tok-1"}: 1, {ID: "k2", Token: "raw-key-tok-2"}: 2},
		ByAny: map[any]int{taggedKey{ID: "k3", Token: "raw-key-tok-3"}: 3, "plain": 4},
	}))
	if strings.Contains(out, "raw-key-tok") {
		t.Fatalf("tagged map key leaked: %s", out)
	}
	var m struct {
		V struct {
			ByKey map[string]struct {
				Key   string
				Value int
			}
			ByAny map[string]struct {
				Key   string
				Value int
			}
		}
	}
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(m.V.ByKey) != 2 {
		t.Errorf("redacted keys must not collide; want 2 entries, got %d: %s", len(m.V.ByKey), out)
	}
	for pos, entry := range m.V.ByKey {
		if entry.Key != redact.Redacted {
			t.Errorf("entry %s key = %q, want %s", pos, entry.Key, redact.Redacted)
		}
	}
	keys := map[string]int{}
	for _, entry := range m.V.ByAny {
		keys[entry.Key] = entry.Value
	}
	if keys[redact.Redacted] != 3 || keys["plain"] != 4 {
		t.Errorf("map[any] keys = %v, want REDACTED:3 and plain:4: %s", keys, out)
	}
}

func TestMapOrderingIsDeterministic(t *testing.T) {
	type holder struct {
		M map[any]int
	}
	v := holder{M: map[any]int{1: 10, "1": 20, int64(1): 30, "0": 40}}
	first := logJSONString(t, "v", redact.Struct(v))
	_, firstV, _ := strings.Cut(first, `"v":`)
	for range 30 {
		_, got, _ := strings.Cut(logJSONString(t, "v", redact.Struct(v)), `"v":`)
		if got != firstV {
			t.Fatalf("map ordering is not deterministic:\n%s\n%s", firstV, got)
		}
	}
}

type lazyCreds struct {
	get func() authInfo
}

func (l lazyCreds) String() string { return "token=" + l.get().Token }

type chanCreds struct {
	ch chan authInfo
}

func (c chanCreds) String() string { return "token=" + (<-c.ch).Token }

func TestTextLeafFailsClosedOnFuncAndChanComponents(t *testing.T) {
	ch := make(chan authInfo, 1)
	ch <- authInfo{Token: "raw-chan-tok"}
	out := logJSONString(t,
		"lazy", redact.Struct(lazyCreds{get: func() authInfo { return authInfo{Token: "raw-func-tok"} }}),
		"chan", redact.Struct(chanCreds{ch: ch}),
	)
	for _, raw := range []string{"raw-func-tok", "raw-chan-tok"} {
		if strings.Contains(out, raw) {
			t.Errorf("value reached through a func or chan leaked %q: %s", raw, out)
		}
	}
}

type panicStringer struct{ N int }

func (panicStringer) String() string { panic("boom") }

func TestPanickingStringerFailsClosed(t *testing.T) {
	type holder struct {
		P panicStringer
	}
	var got slog.Value
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("LogValue panicked: %v", r)
			}
		}()
		got = redact.Struct(holder{P: panicStringer{N: 1}}).LogValue()
	}()
	members := got.Group()
	if len(members) != 1 || members[0].Value.String() != redact.Redacted {
		t.Errorf("panicking Stringer = %v, want P=%s", got, redact.Redacted)
	}
}
