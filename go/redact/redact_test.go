package redact_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
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
