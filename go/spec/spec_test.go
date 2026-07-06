package spec_test

import (
	"log/slog"
	"testing"

	"github.com/jamesainslie/libo11y/go/spec"
)

func TestSeverityNumberMapping(t *testing.T) {
	cases := map[slog.Level]int{
		slog.LevelDebug: 5,
		slog.LevelInfo:  9,
		slog.LevelWarn:  13,
		slog.LevelError: 17,
	}
	for level, want := range cases {
		if got := spec.SeverityNumber(level); got != want {
			t.Errorf("SeverityNumber(%v) = %d, want %d", level, got, want)
		}
	}
}

func TestSchemaIdentityPopulated(t *testing.T) {
	if spec.SchemaURL == "" {
		t.Error("SchemaURL is empty")
	}
	if spec.SpecVersion == "" {
		t.Error("SpecVersion is empty")
	}
	if spec.SemconvVersion == "" {
		t.Error("SemconvVersion is empty")
	}
}

func TestMintedAttributeConstructors(t *testing.T) {
	if kv := spec.OutcomeValue(spec.OutcomeSuccess); kv.Key != spec.OutcomeKey || kv.Value.AsString() != "success" {
		t.Errorf("OutcomeValue = %v, want o11y.outcome=success", kv)
	}
	if kv := spec.Duration(0.5); kv.Value.AsFloat64() != 0.5 {
		t.Errorf("Duration = %v, want 0.5", kv)
	}
	if kv := spec.Label("region", "emea"); string(kv.Key) != "o11y.label.region" || kv.Value.AsString() != "emea" {
		t.Errorf("Label = %v, want o11y.label.region=emea", kv)
	}
}

func TestEventNamesRegistered(t *testing.T) {
	if spec.EventTelemetryConfigured != "o11y.telemetry.configured" {
		t.Errorf("EventTelemetryConfigured = %q", spec.EventTelemetryConfigured)
	}
	if spec.EventRequestSummary != "o11y.request.summary" {
		t.Errorf("EventRequestSummary = %q", spec.EventRequestSummary)
	}
}
