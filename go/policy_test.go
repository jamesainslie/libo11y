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

func TestPolicyKV(t *testing.T) {
	secret := map[attribute.Key]spectables.Sensitivity{"test.secret": spectables.Secret}
	hashing := newSensitivityPolicy(newSettings([]Option{
		WithPIIMode(PIIHash), WithSensitivityForTest(secret),
	}), nil)

	if out, act := hashing.kv(spec.SignalTraces, attribute.String("test.secret", "x")); act != actionDrop || out.Valid() {
		t.Errorf("secret kv: %v %v, want an invalid KeyValue and drop", out, act)
	}
	out, act := hashing.kv(spec.SignalTraces, attribute.String("host.ip", "10.0.0.1"))
	if act != actionRewrite || out.Key != "host.ip" || out.Value.AsString() != hashValue("10.0.0.1") {
		t.Errorf("PII kv under PIIHash: %v %v, want the hash token and rewrite", out, act)
	}
	public := attribute.Int("http.response.status_code", 200)
	if out, act := hashing.kv(spec.SignalLogs, public); act != actionKeep || out != public {
		t.Errorf("public kv: %v %v, want it unchanged and keep", out, act)
	}

	allowing := newSensitivityPolicy(newSettings([]Option{WithPIIMode(PIIAllow)}), nil)
	pii := attribute.String("host.ip", "10.0.0.1")
	if out, act := allowing.kv(spec.SignalMetrics, pii); act != actionKeep || out != pii {
		t.Errorf("PII kv under PIIAllow: %v %v, want it unchanged and keep", out, act)
	}
}
