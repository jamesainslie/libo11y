package redact_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"

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
