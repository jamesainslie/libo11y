package o11y

import (
	"log/slog"
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
