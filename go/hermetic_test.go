package o11y_test

import (
	"context"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

func TestWithoutOTELEnvBuildsNoEnvExporters(t *testing.T) {
	t.Setenv("OTEL_TRACES_EXPORTER", "otlp")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1") // nothing listens
	t.Setenv("OTEL_SERVICE_NAME", "ambient")
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("hermetic"), o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	cfg := sdk.EffectiveConfig()
	for _, leak := range []string{"127.0.0.1:1", "ambient"} {
		if strings.Contains(cfg, leak) {
			t.Errorf("EffectiveConfig %q leaked ambient %q", cfg, leak)
		}
	}
	for _, want := range []string{"o11y.config.traces=none", "o11y.config.metrics=none", "o11y.config.logs=none"} {
		if !strings.Contains(cfg, want) {
			t.Errorf("EffectiveConfig %q does not report %q for a signal with no injected exporter", cfg, want)
		}
	}
	if err := sdk.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown with no exporters: %v", err)
	}
}

func TestWithoutOTELEnvDisablesLogExportWithoutExporter(t *testing.T) {
	t.Setenv("OTEL_LOGS_EXPORTER", "console")
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("hermetic"), o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
	if _, ok := sdk.LoggerProvider().(*sdklog.LoggerProvider); ok {
		t.Error("LoggerProvider is an SDK provider; want the no-op provider when no log exporter is injected")
	}
}

// WithoutOTELEnv's own sampler, exemplar-filter, and cardinality pins, with no
// sampler or filter option to hide them.
func TestWithoutOTELEnvPinsSamplerExemplarFilterAndCardinality(t *testing.T) {
	t.Setenv("OTEL_TRACES_SAMPLER", "always_off")
	t.Setenv("OTEL_METRICS_EXEMPLAR_FILTER", "always_off")
	t.Setenv("OTEL_GO_X_CARDINALITY_LIMIT", "1")
	spans := tracetest.NewSpanRecorder()
	reader := sdkmetric.NewManualReader()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("hermetic"), o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics(),
		o11y.WithSpanProcessor(spans), o11y.WithMetricReader(reader))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })

	meter := sdk.MeterProvider().Meter("t")
	hist, err := meter.Float64Histogram("h")
	if err != nil {
		t.Fatal(err)
	}
	counter, err := meter.Int64Counter("c")
	if err != nil {
		t.Fatal(err)
	}
	ctx, span := sdk.TracerProvider().Tracer("t").Start(context.Background(), "op")
	hist.Record(ctx, 1.5)
	for _, set := range []string{"a", "b", "c"} {
		counter.Add(ctx, 1, metric.WithAttributes(attribute.String("set", set)))
	}
	span.End()

	if n := len(spans.Ended()); n != 1 {
		t.Errorf("recorded %d spans, want 1 (ambient OTEL_TRACES_SAMPLER leaked in)", n)
	}

	var data metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &data); err != nil {
		t.Fatalf("Collect: %v", err)
	}
	var exemplars, points int
	for _, scope := range data.ScopeMetrics {
		for _, m := range scope.Metrics {
			switch agg := m.Data.(type) {
			case metricdata.Histogram[float64]:
				for _, dp := range agg.DataPoints {
					exemplars += len(dp.Exemplars)
				}
			case metricdata.Sum[int64]:
				for _, dp := range agg.DataPoints {
					if v, ok := dp.Attributes.Value("otel.metric.overflow"); ok && v.AsBool() {
						t.Errorf("counter produced an overflow series (ambient OTEL_GO_X_CARDINALITY_LIMIT leaked in)")
					}
					points++
				}
			}
		}
	}
	if exemplars == 0 {
		t.Error("histogram recorded inside a sampled span has no exemplar (ambient OTEL_METRICS_EXEMPLAR_FILTER leaked in)")
	}
	if points != 3 {
		t.Errorf("counter has %d data points, want 3 (ambient OTEL_GO_X_CARDINALITY_LIMIT leaked in)", points)
	}
}

// The log provider merges the environment resource underneath the one it is
// given; ambient keys must be shadowed so none reaches an exported record.
func TestWithoutOTELEnvShadowsAmbientResourceOnLogs(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "team=ambient-team,host.name=ambient-host")
	exp := &memLogExporter{}
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("hermetic"), o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics(),
		o11y.WithLogExporter(exp))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })

	sdk.Logger().Info("hello")
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatalf("ForceFlush: %v", err)
	}
	recs := exp.snapshot()
	if len(recs) != 1 {
		t.Fatalf("exported %d records, want 1", len(recs))
	}
	for _, kv := range recs[0].Resource().Attributes() {
		if v := kv.Value.String(); v == "ambient-team" || v == "ambient-host" {
			t.Errorf("log record resource carries ambient %s=%q from OTEL_RESOURCE_ATTRIBUTES", kv.Key, v)
		}
	}
	for _, kv := range sdk.Resource().Attributes() {
		if v := kv.Value.String(); v == "ambient-team" || v == "ambient-host" {
			t.Errorf("SDK resource carries ambient %s=%q", kv.Key, v)
		}
	}
}

func TestWithoutOTELEnvPinsLogRecordLimits(t *testing.T) {
	t.Setenv("OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT", "1")
	t.Setenv("OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT", "1")
	exp := &memLogExporter{}
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("hermetic"), o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics(),
		o11y.WithLogExporter(exp))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
	if want := "o11y.config.logs=injected"; !strings.Contains(sdk.EffectiveConfig(), want) {
		t.Errorf("EffectiveConfig %q missing %q", sdk.EffectiveConfig(), want)
	}

	sdk.Logger().Info("hello", "first", "alpha", "second", "beta")
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatalf("ForceFlush: %v", err)
	}
	recs := exp.snapshot()
	if len(recs) != 1 {
		t.Fatalf("exported %d records, want 1", len(recs))
	}
	attrs := logAttrs(recs[0])
	if attrs["first"] != "alpha" || attrs["second"] != "beta" {
		t.Errorf("record attributes %v truncated: ambient OTEL_LOGRECORD_* limits leaked in", attrs)
	}
}
