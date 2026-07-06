package spectables_test

import (
	"testing"

	"go.opentelemetry.io/otel/attribute"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
)

func TestRequiredTier0Complete(t *testing.T) {
	want := map[string]bool{
		"service.name":                true,
		"service.version":             true,
		"deployment.environment.name": true,
		"telemetry.sdk.name":          true,
		"telemetry.sdk.language":      true,
		"telemetry.sdk.version":       true,
	}
	for _, key := range spectables.RequiredTier0 {
		delete(want, string(key))
	}
	for missing := range want {
		t.Errorf("RequiredTier0 missing %q", missing)
	}
}

func TestEnvironmentValues(t *testing.T) {
	for _, env := range []string{"production", "staging", "development", "test"} {
		if !spectables.EnvironmentValues[env] {
			t.Errorf("EnvironmentValues missing %q", env)
		}
	}
	if spectables.EnvironmentValues["prod"] {
		t.Error("EnvironmentValues should not contain the abbreviation prod")
	}
}

func TestForbiddenAttributesClassifiedPII(t *testing.T) {
	for _, key := range []string{"host.ip", "host.mac", "process.command_line", "device.id"} {
		if got := spectables.SensitivityOf[attribute.Key(key)]; got != spectables.PII {
			t.Errorf("SensitivityOf[%q] = %v, want PII", key, got)
		}
	}
}

func TestMetricLabelsAreIdentityQuintet(t *testing.T) {
	if len(spectables.MetricResourceLabels) != 5 {
		t.Fatalf("MetricResourceLabels has %d entries, want the identity quintet of 5", len(spectables.MetricResourceLabels))
	}
	want := map[string]bool{
		"service.name": true, "service.namespace": true, "service.instance.id": true,
		"deployment.environment.name": true, "service.version": true,
	}
	for _, key := range spectables.MetricResourceLabels {
		if !want[string(key)] {
			t.Errorf("unexpected metric label %q", key)
		}
	}
}

func TestEventsRegistered(t *testing.T) {
	if _, ok := spectables.Events["o11y.request.summary"]; !ok {
		t.Error("o11y.request.summary not registered")
	}
	info := spectables.Events["o11y.telemetry.dropped"]
	if len(info.Required) == 0 {
		t.Error("o11y.telemetry.dropped has no required attributes")
	}
}
