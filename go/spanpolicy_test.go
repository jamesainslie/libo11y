package o11y_test

import (
	"context"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/internal/spectables"
	"github.com/jamesainslie/libo11y/go/spec"
)

func emitClassifiedSpan(sdk *o11y.SDK) {
	tr := sdk.TracerProvider().Tracer("t")
	_, other := tr.Start(context.Background(), "other")
	other.End()
	_, span := tr.Start(context.Background(), "op",
		trace.WithAttributes(attribute.String("host.ip", "10.9.8.7"), attribute.String("test.secret", "s3"), attribute.String("safe", "ok")),
		trace.WithLinks(trace.Link{SpanContext: other.SpanContext(), Attributes: []attribute.KeyValue{attribute.String("test.secret", "s3")}}))
	span.AddEvent("e", trace.WithAttributes(attribute.String("host.ip", "10.9.8.7")))
	span.End()
}

func assertSpanClean(t *testing.T, where string, s sdktrace.ReadOnlySpan) {
	t.Helper()
	all := append([]attribute.KeyValue{}, s.Attributes()...)
	for _, e := range s.Events() {
		all = append(all, e.Attributes...)
	}
	for _, l := range s.Links() {
		all = append(all, l.Attributes...)
	}
	for _, kv := range all {
		if kv.Value.String() == "10.9.8.7" || kv.Value.String() == "s3" {
			t.Errorf("%s span %q leaked %s=%s", where, s.Name(), kv.Key, kv.Value.String())
		}
	}
}

var secretTable = map[attribute.Key]spectables.Sensitivity{"test.secret": spectables.Secret}

func TestInjectedProcessorAndExporterReceiveRedactedSpans(t *testing.T) {
	t.Parallel()
	exported := tracetest.NewInMemoryExporter()
	sdk, recorder, _, _ := newHermetic(t,
		o11y.WithSensitivityForTest(secretTable),
		o11y.WithTraceExporter(exported))
	emitClassifiedSpan(sdk)
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	ended := recorder.Ended()
	if len(ended) != 2 {
		t.Fatalf("processor got %d spans, want 2", len(ended))
	}
	for _, s := range ended {
		assertSpanClean(t, "processor", s)
	}
	stubs := exported.GetSpans()
	if len(stubs) != 2 {
		t.Fatalf("exporter got %d spans, want 2 (processor must not displace the exporter)", len(stubs))
	}
	for _, s := range stubs.Snapshots() {
		assertSpanClean(t, "exporter", s)
	}
}

func TestSpanAndLogPIITokensAgree(t *testing.T) {
	t.Parallel()
	sdk, recorder, _, console := newHermetic(t, o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey))
	_, span := sdk.TracerProvider().Tracer("t").Start(context.Background(), "op",
		trace.WithAttributes(attribute.String("host.ip", "10.9.8.7")))
	span.End()
	sdk.Logger().Info("m", "host.ip", "10.9.8.7")

	var spanToken string
	for _, kv := range recorder.Ended()[0].Attributes() {
		if kv.Key == "host.ip" {
			spanToken = kv.Value.String()
		}
	}
	logToken, _ := consoleRecords(t, console)[0]["host.ip"].(string)
	if spanToken == "" || spanToken != logToken || spanToken == "10.9.8.7" {
		t.Errorf("span token %q and log token %q must be equal HMAC tokens", spanToken, logToken)
	}
}

// A processor injected without an exporter owns the export path: no
// exporter is built from the environment, so an unusable
// OTEL_TRACES_EXPORTER cannot fail construction.
func TestSpanProcessorAloneBuildsNoEnvExporter(t *testing.T) {
	t.Setenv("OTEL_TRACES_EXPORTER", "no-such-exporter")
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("processor-only"), o11y.WithEnvironment(spec.EnvironmentTest), o11y.WithoutLogExport(), o11y.WithoutConsoleLog(),
		o11y.WithoutRuntimeMetrics(), o11y.WithMetricReader(sdkmetric.NewManualReader()),
		o11y.WithSpanProcessor(tracetest.NewSpanRecorder()))
	if err != nil {
		t.Fatalf("New with only a span processor built an environment exporter: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
	if cfg := sdk.EffectiveConfig(); !strings.Contains(cfg, "o11y.config.traces=injected") {
		t.Errorf("EffectiveConfig %q, want o11y.config.traces=injected", cfg)
	}
}

// traceViolationPoints returns the o11y.schema.violations data points on
// the traces signal.
func traceViolationPoints(t *testing.T, reader *sdkmetric.ManualReader) []metricdata.DataPoint[int64] {
	t.Helper()
	var md metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &md); err != nil {
		t.Fatal(err)
	}
	var points []metricdata.DataPoint[int64]
	for _, sm := range md.ScopeMetrics {
		for _, m := range sm.Metrics {
			sum, ok := m.Data.(metricdata.Sum[int64])
			if m.Name != "o11y.schema.violations" || !ok {
				continue
			}
			for _, p := range sum.DataPoints {
				if signal, _ := p.Attributes.Value(spec.SignalKey); signal.AsString() == string(spec.SignalTraces) {
					points = append(points, p)
				}
			}
		}
	}
	return points
}

// One classified span attribute is one violation, however many span
// destinations (an injected processor, an exporter, or both) redact it.
func TestSpanViolationCountedOnce(t *testing.T) {
	t.Parallel()
	for name, extra := range map[string][]o11y.Option{
		"processor":          nil,
		"processor+exporter": {o11y.WithTraceExporter(tracetest.NewInMemoryExporter())},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			sdk, _, reader, _ := newHermetic(t, extra...)
			_, span := sdk.TracerProvider().Tracer("t").Start(context.Background(), "op",
				trace.WithAttributes(attribute.String("host.ip", "10.9.8.7")))
			span.End()
			if err := sdk.ForceFlush(context.Background()); err != nil {
				t.Fatal(err)
			}
			points := traceViolationPoints(t, reader)
			if len(points) != 1 || points[0].Value != 1 {
				t.Fatalf("traces violation points = %+v, want one point with value 1", points)
			}
			if rule, _ := points[0].Attributes.Value(spec.RuleKey); rule.AsString() != "pii_attribute" {
				t.Errorf("rule = %q, want pii_attribute", rule.AsString())
			}
		})
	}
}
