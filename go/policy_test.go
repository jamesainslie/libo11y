package o11y

import (
	"log/slog"
	"net"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
	"github.com/jamesainslie/libo11y/go/spec"
)

func TestPolicyUsesInjectedLookup(t *testing.T) {
	s := newSettings([]Option{
		WithPIIMode(PIIDrop),
		WithSensitivityForTest(map[attribute.Key]spectables.Sensitivity{"test.secret": spectables.Secret}),
	})
	p := newSensitivityPolicy(s, nil)
	if got := p.decide(spec.SignalLogs, "test.secret"); got != actionDrop {
		t.Errorf("injected secret: %v, want drop", got)
	}
	if got := p.decide(spec.SignalLogs, "host.ip"); got != actionDrop {
		t.Errorf("generated PII under PIIDrop: %v, want drop", got)
	}
	if got := p.decide(spec.SignalLogs, "service.name"); got != actionKeep {
		t.Errorf("public key: %v, want keep", got)
	}
	if _, ok := spectables.SensitivityOf["test.secret"]; ok {
		t.Fatal("the generated table was mutated")
	}
	if a, act := p.slogAttr([]string{"test"}, slog.String("secret", "x")); act != actionDrop || a.Key != "" {
		t.Errorf("grouped injected secret not dropped: %v %v", a, act)
	}
}

func TestCanonicalRenderingMatchesAcrossValueKinds(t *testing.T) {
	for _, tc := range []struct {
		name string
		slog slog.Value
		attr attribute.Value
		want string
	}{
		{"string", slog.StringValue("10.0.0.1"), attribute.StringValue("10.0.0.1"), "10.0.0.1"},
		{"int", slog.Int64Value(-7), attribute.Int64Value(-7), "-7"},
		{"float", slog.Float64Value(1e21), attribute.Float64Value(1e21), "1e+21"},
		{"bool", slog.BoolValue(true), attribute.BoolValue(true), "true"},
		{"bytes", slog.AnyValue([]byte("ab")), attribute.ByteSliceValue([]byte("ab")), "YWI="},
		{
			"string slice", slog.AnyValue([]string{"a", "b\""}),
			attribute.StringSliceValue([]string{"a", "b\""}), `["a","b\""]`,
		},
		{"int slice", slog.AnyValue([]int{1, 2}), attribute.IntSliceValue([]int{1, 2}), `["1","2"]`},
		{"float slice", slog.AnyValue([]float64{0.5}), attribute.Float64SliceValue([]float64{0.5}), `["0.5"]`},
		{"bool slice", slog.AnyValue([]bool{false}), attribute.BoolSliceValue([]bool{false}), `["false"]`},
		{"empty slice", slog.AnyValue([]string{}), attribute.StringSliceValue(nil), `[]`},
		{"net.IP", slog.AnyValue(net.ParseIP("10.9.8.7")), attribute.StringValue("10.9.8.7"), "10.9.8.7"},
		{
			"net.HardwareAddr", slog.AnyValue(net.HardwareAddr{0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff}),
			attribute.StringValue("aa:bb:cc:dd:ee:ff"), "aa:bb:cc:dd:ee:ff",
		},
		{
			"net.IP slice", slog.AnyValue([]net.IP{net.ParseIP("10.9.8.7")}),
			attribute.StringSliceValue([]string{"10.9.8.7"}), `["10.9.8.7"]`,
		},
		{
			"map", slog.AnyValue(map[string]any{"b": 2, "a": "x"}),
			attribute.MapValue(attribute.Int64("b", 2), attribute.String("a", "x")), `{"a":"x","b":"2"}`,
		},
		{"empty map", slog.AnyValue(map[string]int{}), attribute.MapValue(), `{}`},
		{
			"nested map", slog.AnyValue(map[string]any{"n": map[string]string{"ip": "1"}}),
			attribute.MapValue(attribute.Map("n", attribute.String("ip", "1"))), `{"n":{"ip":"1"}}`,
		},
		{
			"non-string keys", slog.AnyValue(map[int]string{7: "x"}),
			attribute.MapValue(attribute.String("7", "x")), `{"7":"x"}`,
		},
		{
			"pointer to map", slog.AnyValue(&map[string]string{"ip": "1"}),
			attribute.MapValue(attribute.String("ip", "1")), `{"ip":"1"}`,
		},
		{"pointer to string", slog.AnyValue(ptr("10.0.0.1")), attribute.StringValue("10.0.0.1"), "10.0.0.1"},
		{
			"slice of maps", slog.AnyValue([]map[string]string{{"ip": "1"}}),
			attribute.SliceValue(attribute.MapValue(attribute.String("ip", "1"))), `[{"ip":"1"}]`,
		},
		{
			"nested slices", slog.AnyValue([][]string{{"a"}, {"b", "c"}}),
			attribute.SliceValue(attribute.StringSliceValue([]string{"a"}), attribute.StringSliceValue([]string{"b", "c"})),
			`[["a"],["b","c"]]`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := canonicalSlog(tc.slog); got != tc.want {
				t.Errorf("canonicalSlog = %q, want %q", got, tc.want)
			}
			if got := canonicalAttr(tc.attr); got != tc.want {
				t.Errorf("canonicalAttr = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestClassifyResourceAttrsCountsPerRule(t *testing.T) {
	s := newSettings([]Option{
		WithPIIMode(PIIHash), WithPIIHashKey(internalTestKey),
		WithSensitivityForTest(map[attribute.Key]spectables.Sensitivity{"test.secret": spectables.Secret}),
	})
	kept, counts := classifyResourceAttrs([]attribute.KeyValue{
		attribute.String("service.name", "svc"),
		attribute.String("test.secret", "s3cr3t"),
		attribute.String("host.ip", "10.0.0.1"),
		attribute.String("host.mac", "aa:bb"),
	}, newSensitivityPolicy(s, nil))

	if counts["secret_attribute"] != 1 || counts["pii_attribute"] != 2 || len(counts) != 2 {
		t.Errorf("counts = %v, want 1 secret_attribute and 2 pii_attribute", counts)
	}
	got := map[attribute.Key]string{}
	for _, kv := range kept {
		got[kv.Key] = kv.Value.AsString()
	}
	want := map[attribute.Key]string{
		"service.name": "svc",
		"host.ip":      wantToken(internalTestKey, "10.0.0.1"),
		"host.mac":     wantToken(internalTestKey, "aa:bb"),
	}
	if len(got) != len(want) {
		t.Errorf("kept = %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("kept[%s] = %q, want %q", k, got[k], v)
		}
	}
}

// TestCanonicalRenderingIgnoresType pins the documented equivalences: the
// canonical form carries the value, not its type.
func TestCanonicalRenderingIgnoresType(t *testing.T) {
	for _, got := range []string{
		canonicalAttr(attribute.StringValue("1")),
		canonicalAttr(attribute.Int64Value(1)),
		canonicalAttr(attribute.Float64Value(1.0)),
		canonicalSlog(slog.Uint64Value(1)),
	} {
		if got != "1" {
			t.Errorf("rendering = %q, want 1", got)
		}
	}
	if s, a := canonicalAttr(attribute.StringValue(`["1","2"]`)), canonicalAttr(attribute.Int64SliceValue([]int64{1, 2})); s != a {
		t.Errorf("JSON-array string %q and slice %q differ", s, a)
	}
	if a, b := canonicalAttr(attribute.StringSliceValue([]string{"\xff"})), canonicalAttr(attribute.StringSliceValue([]string{"\xfe"})); a != b {
		t.Errorf("invalid UTF-8 slice elements render differently: %q vs %q", a, b)
	}
}

// TestCanonicalAnyNilPointerWithValueMethods pins that a nil pointer whose
// type has value-receiver text methods renders without panicking.
func TestCanonicalAnyNilPointerWithValueMethods(t *testing.T) {
	if got := canonicalAny((*net.IP)(nil)); got != "<nil>" {
		t.Errorf("canonicalAny(nil *net.IP) = %q, want <nil>", got)
	}
}

func ptr[T any](v T) *T { return &v }

func TestCanonicalAnySelfReferencingMapTerminates(t *testing.T) {
	m := map[string]any{"ip": "1"}
	m["self"] = m
	if got := canonicalAny(m); !strings.Contains(got, canonicalDepthExceeded) {
		t.Errorf("canonicalAny(cycle) = %q, want it cut at %q", got, canonicalDepthExceeded)
	}
}
