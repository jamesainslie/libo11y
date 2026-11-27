package spec_test

import (
	"log/slog"
	"slices"
	"testing"

	"go.opentelemetry.io/otel/attribute"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
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

func TestMetricNamesRegistered(t *testing.T) {
	if spec.MetricSchemaViolations != "o11y.schema.violations" {
		t.Errorf("MetricSchemaViolations = %q", spec.MetricSchemaViolations)
	}
}

func TestRUMConventions(t *testing.T) {
	for _, tc := range []struct {
		name, got, want string
	}{
		{"RUMPlatformKey", string(spec.RUMPlatformKey), "o11y.rum.platform"},
		{"RUMViewNameKey", string(spec.RUMViewNameKey), "o11y.rum.view.name"},
		{"RUMElementTextKey", string(spec.RUMElementTextKey), "o11y.rum.element.text"},
		{"MetricRUMVitalLCP", spec.MetricRUMVitalLCP, "o11y.rum.vital.lcp"},
		{"MetricRUMViews", spec.MetricRUMViews, "o11y.rum.views"},
		{"EventRUMError", spec.EventRUMError, "o11y.rum.error"},
		{"RUMViewKindScreen", string(spec.RUMViewKindScreen), "screen"},
		{"RUMConnectionEffectiveSlow2g", string(spec.RUMConnectionEffectiveSlow2g), "slow-2g"},
		{"RUMConnectionEffectiveType2g", string(spec.RUMConnectionEffectiveType2g), "2g"},
		{"RUMVitalRatingNeedsImprovement", string(spec.RUMVitalRatingNeedsImprovement), "needs-improvement"},
	} {
		if tc.got != tc.want {
			t.Errorf("spec.%s = %q, want %q", tc.name, tc.got, tc.want)
		}
	}
}

func TestLogSourceMinted(t *testing.T) {
	if spec.LogSourceKey != "o11y.log.source" {
		t.Errorf("LogSourceKey = %q, want o11y.log.source", spec.LogSourceKey)
	}
	if kv := spec.LogSourceValue(spec.LogSourceConsole); kv.Key != spec.LogSourceKey || kv.Value.AsString() != "console" {
		t.Errorf("LogSourceValue(LogSourceConsole) = %v, want o11y.log.source=console", kv)
	}
	if spec.LogSourceLogger != "logger" {
		t.Errorf("LogSourceLogger = %q, want logger", spec.LogSourceLogger)
	}
}

// TestViewSummaryMinted pins the spec 1.3.0 view summary event: its name,
// its typed attribute constructors, and the required attributes its
// contract lists.
func TestViewSummaryMinted(t *testing.T) {
	if spec.EventRUMViewSummary != "o11y.rum.view.summary" {
		t.Errorf("EventRUMViewSummary = %q, want o11y.rum.view.summary", spec.EventRUMViewSummary)
	}
	if kv := spec.RUMSummarySeq(0); kv.Key != "o11y.rum.summary.seq" || kv.Value.Type() != attribute.INT64 {
		t.Errorf("RUMSummarySeq(0) = %v, want an int o11y.rum.summary.seq", kv)
	}
	if kv := spec.RUMSummaryLCPValue(1.8); kv.Key != "o11y.rum.summary.lcp.value" || kv.Value.Type() != attribute.FLOAT64 {
		t.Errorf("RUMSummaryLCPValue(1.8) = %v, want a double o11y.rum.summary.lcp.value", kv)
	}
	if spec.RUMSummaryErrorsUnhandledRejectionKey != "o11y.rum.summary.errors.unhandled_rejection" {
		t.Errorf("RUMSummaryErrorsUnhandledRejectionKey = %q, want o11y.rum.summary.errors.unhandled_rejection", spec.RUMSummaryErrorsUnhandledRejectionKey)
	}
	info, ok := spectables.Events[spec.EventRUMViewSummary]
	if !ok {
		t.Fatal("spectables.Events lacks o11y.rum.view.summary")
	}
	for _, key := range []attribute.Key{spec.RUMSummarySeqKey, spec.RUMSummaryTimeOnViewKey, spec.RUMViewIDKey} {
		if !slices.Contains(info.Required, key) {
			t.Errorf("o11y.rum.view.summary required = %v, missing %s", info.Required, key)
		}
	}
}

// TestAppUpdateIDMinted pins o11y.rum.app.update_id (spec 1.3.0), the
// over-the-air update a mobile app runs.
func TestAppUpdateIDMinted(t *testing.T) {
	if kv := spec.RUMAppUpdateID("0d1f5a4e"); kv.Key != "o11y.rum.app.update_id" || kv.Value.AsString() != "0d1f5a4e" {
		t.Errorf("RUMAppUpdateID = %v, want o11y.rum.app.update_id=0d1f5a4e", kv)
	}
}

func TestRUMSpanShapeMarkerRequired(t *testing.T) {
	shapes := []spec.RUMSpanShape{spec.RUMSpanShapeView, spec.RUMSpanShapeAction, spec.RUMSpanShapeAppLoad}
	if len(spectables.RUMSpanRequired) != len(shapes) {
		t.Fatalf("RUMSpanRequired has %d shapes, want %d", len(spectables.RUMSpanRequired), len(shapes))
	}
	for _, shape := range shapes {
		required, ok := spectables.RUMSpanRequired[string(shape)]
		if !ok {
			t.Errorf("RUMSpanRequired lacks the %q shape named by o11y.rum.span.shape", shape)
			continue
		}
		if !slices.Contains(required, spec.RUMSpanShapeKey) {
			t.Errorf("the %q shape does not require %s: %v", shape, spec.RUMSpanShapeKey, required)
		}
	}
}
