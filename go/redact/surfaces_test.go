package redact_test

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/jamesainslie/libo11y/go/redact"
)

// surfaceAccount carries every protection, with raw values distinctive enough
// that a substring check cannot match by accident.
type surfaceAccount struct {
	Email   string `o11y:"confidential"`
	Role    string
	Card    string `o11y:"mask"`
	Token   string `o11y:"secret"`
	PIN     string `o11y:"omit"`
	Profile surfaceProfile
}

type surfaceProfile struct {
	City string
	SSN  string `o11y:"redact"`
}

var testAccount = surfaceAccount{
	Email:   "alice@example.co",
	Role:    "admin-role",
	Card:    "4111222233334444",
	Token:   "tok-9f8e7d",
	PIN:     "pin-2468",
	Profile: surfaceProfile{City: "Lisbon-city", SSN: "ssn-078051120"},
}

// rawProtected are values no surface may print; rawPublic must survive.
var (
	rawProtected = []string{"alice@example.co", "4111222233334444", "tok-9f8e7d", "pin-2468", "ssn-078051120"}
	rawPublic    = []string{"admin-role", "Lisbon-city"}
)

func assertProtected(t *testing.T, surface, got string) {
	t.Helper()
	for _, raw := range rawProtected {
		if strings.Contains(got, raw) {
			t.Errorf("%s leaked %q: %s", surface, raw, got)
		}
	}
	for _, public := range rawPublic {
		if !strings.Contains(got, public) {
			t.Errorf("%s lost unprotected value %q: %s", surface, public, got)
		}
	}
}

// TestStructGuardsFmtVerbs pins that every fmt surface renders the
// protected form, at the top level and nested inside other values.
func TestStructGuardsFmtVerbs(t *testing.T) {
	v := redact.Struct(testAccount)
	type wrapper struct {
		Account any
		Label   string
	}
	type hidden struct {
		surfaceAccount any
	}
	surfaces := map[string]string{
		"%v":                fmt.Sprintf("%v", v),
		"%+v":               fmt.Sprintf("%+v", v),
		"%#v":               fmt.Sprintf("%#v", v),
		"%s":                fmt.Sprintf("%s", v),
		"%q":                fmt.Sprintf("%q", v),
		"%d":                fmt.Sprintf("%d", v),
		"%x":                fmt.Sprintf("%x", v),
		"Sprint":            fmt.Sprint(v),
		"Sprintln":          fmt.Sprintln(v),
		"String":            callString(v),
		"GoString":          callGoString(v),
		"nested %v":         fmt.Sprintf("%v", wrapper{Account: v, Label: "x"}),
		"nested %+v":        fmt.Sprintf("%+v", wrapper{Account: v, Label: "x"}),
		"nested %#v":        fmt.Sprintf("%#v", wrapper{Account: v, Label: "x"}),
		"slice %v":          fmt.Sprintf("%v", []any{v, v}),
		"slice %#v":         fmt.Sprintf("%#v", []any{v}),
		"map %v":            fmt.Sprintf("%v", map[string]any{"a": v}),
		"pointer %+v":       fmt.Sprintf("%+v", &wrapper{Account: v}),
		"unexported %+v":    fmt.Sprintf("%+v", hidden{surfaceAccount: v}),
		"unexported %#v":    fmt.Sprintf("%#v", hidden{surfaceAccount: v}),
		"pointer arg %v":    fmt.Sprintf("%v", redact.Struct(&testAccount)),
		"Errorf %v wrapped": fmt.Errorf("failed for %v", v).Error(),
	}
	for name, got := range surfaces {
		t.Run(name, func(t *testing.T) {
			for _, raw := range rawProtected {
				if strings.Contains(got, raw) {
					t.Errorf("leaked %q: %s", raw, got)
				}
			}
		})
	}
	// The direct surfaces render the protected form itself, so unprotected
	// values stay readable.
	for _, name := range []string{"%v", "%+v", "%#v", "%s", "%q", "%d", "Sprint", "String", "GoString", "nested %v", "slice %v"} {
		assertProtected(t, name, surfaces[name])
	}
}

// TestStructFmtFormIsDeterministic pins the documented text form: the
// same text on every verb, fields in declaration order as Name:value,
// nested groups in braces, and omitted fields absent.
func TestStructFmtFormIsDeterministic(t *testing.T) {
	v := redact.Struct(testAccount)
	want := "{Email:XXXXXXXXXXXXXXXX Role:admin-role Card:XXXXXXXXXXXXXXXX Token:REDACTED " +
		"Profile:{City:Lisbon-city SSN:REDACTED}}"
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q", "%d"} {
		if got := fmt.Sprintf(verb, v); got != want {
			t.Errorf("%s = %s, want %s", verb, got, want)
		}
	}
}

// TestStructGuardsJSON pins that encoding/json renders the protected form
// as an object, with omitted fields absent and nested structs as nested
// objects, at the top level and nested inside other values.
func TestStructGuardsJSON(t *testing.T) {
	v := redact.Struct(testAccount)
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	assertProtected(t, "json", string(b))

	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal %s: %v", b, err)
	}
	want := map[string]any{
		"Email":   "XXXXXXXXXXXXXXXX",
		"Role":    "admin-role",
		"Card":    "XXXXXXXXXXXXXXXX",
		"Token":   redact.Redacted,
		"Profile": map[string]any{"City": "Lisbon-city", "SSN": redact.Redacted},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("json = %s, want %v", b, want)
	}
	if _, present := got["PIN"]; present {
		t.Errorf("omitted field present in %s", b)
	}

	nested := map[string]any{
		"struct": struct{ Account any }{Account: v},
		"slice":  []any{v},
		"map":    map[string]any{"a": v},
	}
	for name, x := range nested {
		b, err := json.Marshal(x)
		if err != nil {
			t.Fatalf("%s: json.Marshal: %v", name, err)
		}
		assertProtected(t, "json "+name, string(b))
	}
}

// TestStructSurfacesFailClosedLikeLogValue pins that fmt and JSON fail
// closed exactly where LogValue does: a cycle renders REDACTED.
func TestStructSurfacesFailClosedLikeLogValue(t *testing.T) {
	type node struct {
		Name string
		Next *node
	}
	n := &node{Name: "loop"}
	n.Next = n
	v := redact.Struct(n)
	if !strings.Contains(v.LogValue().String(), redact.Redacted) {
		t.Fatalf("LogValue of a cycle = %s, want REDACTED inside", v.LogValue())
	}
	if got := fmt.Sprint(v); !strings.Contains(got, redact.Redacted) || !strings.Contains(got, "loop") {
		t.Errorf("fmt of a cycle = %s, want the names and REDACTED where the cycle is cut", got)
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	if !strings.Contains(string(b), redact.Redacted) {
		t.Errorf("json of a cycle = %s, want REDACTED where the cycle is cut", b)
	}
}

// TestStructJSONOfScalarsAndNil covers non-struct inputs, which render as
// the JSON form of their LogValue.
func TestStructJSONOfScalarsAndNil(t *testing.T) {
	tests := []struct {
		in   any
		want string
	}{
		{in: nil, want: "null"},
		{in: 42, want: "42"},
		{in: "plain", want: `"plain"`},
		{in: true, want: "true"},
		{in: []string{"a", "b"}, want: `{"0":"a","1":"b"}`},
	}
	for _, tt := range tests {
		b, err := json.Marshal(redact.Struct(tt.in))
		if err != nil {
			t.Errorf("json.Marshal(Struct(%v)): %v", tt.in, err)
			continue
		}
		if string(b) != tt.want {
			t.Errorf("json.Marshal(Struct(%#v)) = %s, want %s", tt.in, b, tt.want)
		}
	}
}

// callString returns x.String(), or a marker when x has no String method.
func callString(x any) string {
	if s, ok := x.(fmt.Stringer); ok {
		return s.String()
	}
	return "<no String method>"
}

// callGoString returns x.GoString(), or a marker when x has no GoString
// method.
func callGoString(x any) string {
	if s, ok := x.(fmt.GoStringer); ok {
		return s.GoString()
	}
	return "<no GoString method>"
}

// TestStructJSONOfLeafKinds pins the JSON form of leaves the Struct doc
// describes: a duration renders as its String form, NaN as a string, a nil
// pointer as null, and a nil func as the text "<nil>".
func TestStructJSONOfLeafKinds(t *testing.T) {
	type leaves struct {
		Wait    time.Duration
		Ratio   float64
		Count   int
		Ptr     *int
		Hook    func()
		Updated time.Time
	}
	at := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	b, err := json.Marshal(redact.Struct(leaves{Wait: time.Second, Ratio: math.NaN(), Count: 3, Updated: at}))
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	want := `{"Wait":"1s","Ratio":"NaN","Count":3,"Ptr":null,"Hook":"\u003cnil\u003e","Updated":"2026-11-25T12:00:00Z"}`
	if string(b) != want {
		t.Errorf("json = %s, want %s", b, want)
	}
}

type durationValuer time.Duration

func (d durationValuer) LogValue() slog.Value { return slog.DurationValue(time.Duration(d)) }

// TestStructJSONOfLogValuerDuration pins that a slog.LogValuer returning
// slog.DurationValue renders in JSON as its String form, matching direct
// time.Duration fields and the text surface.
func TestStructJSONOfLogValuerDuration(t *testing.T) {
	type holder struct {
		Wait durationValuer
	}
	b, err := json.Marshal(redact.Struct(holder{Wait: durationValuer(time.Second)}))
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	want := `{"Wait":"1s"}`
	if string(b) != want {
		t.Errorf("json = %s, want %s", b, want)
	}
}
