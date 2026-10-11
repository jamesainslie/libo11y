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
