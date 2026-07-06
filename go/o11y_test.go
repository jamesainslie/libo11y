package o11y_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

// newHermetic builds an SDK with every external pipeline replaced by an
// in-memory one, so tests never dial a collector.
func newHermetic(t *testing.T, extra ...o11y.Option) (*o11y.SDK, *tracetest.SpanRecorder, *sdkmetric.ManualReader, *bytes.Buffer) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	reader := sdkmetric.NewManualReader()
	var console bytes.Buffer
	opts := append([]o11y.Option{
		o11y.WithServiceName("libo11y-test"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(recorder),
		o11y.WithMetricReader(reader),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithConsoleWriter(&console),
	}, extra...)
	sdk, err := o11y.New(context.Background(), opts...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() {
		if err := sdk.Shutdown(context.Background()); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	})
	return sdk, recorder, reader, &console
}

func consoleRecords(t *testing.T, console *bytes.Buffer) []map[string]any {
	t.Helper()
	var records []map[string]any
	for line := range strings.Lines(console.String()) {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("unmarshal console line %q: %v", line, err)
		}
		records = append(records, m)
	}
	return records
}

func TestNewRequiresServiceName(t *testing.T) {
	_, err := o11y.New(context.Background(),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithSpanProcessor(tracetest.NewSpanRecorder()),
		o11y.WithMetricReader(sdkmetric.NewManualReader()),
	)
	if !errors.Is(err, o11y.ErrNoServiceName) {
		t.Fatalf("New without service name: err = %v, want ErrNoServiceName", err)
	}
}

func TestServiceNameFromEnvironment(t *testing.T) {
	t.Setenv("OTEL_SERVICE_NAME", "env-service")
	sdk, _, _, _ := newHermeticNamed(t)
	assertServiceName(t, sdk, "env-service")
}

func TestServiceNameOptionOverridesEnvironment(t *testing.T) {
	t.Setenv("OTEL_SERVICE_NAME", "env-service")
	sdk, _, _, _ := newHermetic(t) // includes WithServiceName("libo11y-test")
	assertServiceName(t, sdk, "libo11y-test")
}

// newHermeticNamed is newHermetic without the WithServiceName option, for
// environment-resolution tests.
func newHermeticNamed(t *testing.T) (*o11y.SDK, *tracetest.SpanRecorder, *sdkmetric.ManualReader, *bytes.Buffer) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	reader := sdkmetric.NewManualReader()
	var console bytes.Buffer
	sdk, err := o11y.New(context.Background(),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(recorder),
		o11y.WithMetricReader(reader),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithConsoleWriter(&console),
	)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() {
		if err := sdk.Shutdown(context.Background()); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	})
	return sdk, recorder, reader, &console
}

func assertServiceName(t *testing.T, sdk *o11y.SDK, want string) {
	t.Helper()
	for _, kv := range sdk.Resource().Attributes() {
		if string(kv.Key) == "service.name" {
			if got := kv.Value.AsString(); got != want {
				t.Errorf("service.name = %q, want %q", got, want)
			}
			return
		}
	}
	t.Errorf("service.name missing from resource")
}

func TestLogTraceCorrelation(t *testing.T) {
	sdk, recorder, _, console := newHermetic(t)

	ctx, span := sdk.TracerProvider().Tracer("test").Start(context.Background(), "operation")
	sdk.Logger().InfoContext(ctx, "inside span", "step", "one")
	span.End()

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	records := consoleRecords(t, console)
	if len(records) != 1 {
		t.Fatalf("got %d console records, want 1", len(records))
	}
	wantTrace := spans[0].SpanContext().TraceID().String()
	if got := records[0]["trace_id"]; got != wantTrace {
		t.Errorf("log trace_id = %v, want %v (one identity across surfaces)", got, wantTrace)
	}
	wantSpan := spans[0].SpanContext().SpanID().String()
	if got := records[0]["span_id"]; got != wantSpan {
		t.Errorf("log span_id = %v, want %v", got, wantSpan)
	}
}

func TestMetricsFlowThroughInjectedReader(t *testing.T) {
	sdk, _, reader, _ := newHermetic(t)

	counter, err := sdk.MeterProvider().Meter("test").Int64Counter("orders.processed")
	if err != nil {
		t.Fatalf("Int64Counter: %v", err)
	}
	counter.Add(context.Background(), 3)

	var data metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &data); err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(data.ScopeMetrics) != 1 || len(data.ScopeMetrics[0].Metrics) != 1 {
		t.Fatalf("unexpected metric shape: %+v", data.ScopeMetrics)
	}
	if got := data.ScopeMetrics[0].Metrics[0].Name; got != "orders.processed" {
		t.Errorf("metric name = %q, want orders.processed", got)
	}
}

func TestRuntimeMetricsDefaultOn(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("rt-test"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(tracetest.NewSpanRecorder()),
		o11y.WithMetricReader(reader),
		o11y.WithoutLogExport(),
		o11y.WithoutConsoleLog(),
	)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() {
		if err := sdk.Shutdown(context.Background()); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	}()

	var data metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &data); err != nil {
		t.Fatalf("Collect: %v", err)
	}
	for _, scope := range data.ScopeMetrics {
		for _, m := range scope.Metrics {
			if strings.HasPrefix(m.Name, "go.") {
				return // runtime instrumentation present
			}
		}
	}
	t.Error("no go.* runtime metrics collected; runtime metrics should default on")
}

func TestWithoutRuntimeMetrics(t *testing.T) {
	sdk, _, reader, _ := newHermetic(t) // newHermetic disables runtime metrics
	_ = sdk

	var data metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &data); err != nil {
		t.Fatalf("Collect: %v", err)
	}
	for _, scope := range data.ScopeMetrics {
		for _, m := range scope.Metrics {
			if strings.HasPrefix(m.Name, "go.") {
				t.Errorf("runtime metric %q present despite WithoutRuntimeMetrics", m.Name)
			}
		}
	}
}

func TestHistogramBucketsView(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	buckets := []float64{0.1, 1, 10}
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("buckets-test"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(tracetest.NewSpanRecorder()),
		o11y.WithMetricReader(reader),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
		o11y.WithHistogramBuckets("request.duration", buckets),
	)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() {
		if err := sdk.Shutdown(context.Background()); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	}()

	hist, err := sdk.MeterProvider().Meter("test").Float64Histogram("request.duration")
	if err != nil {
		t.Fatalf("Float64Histogram: %v", err)
	}
	hist.Record(context.Background(), 0.5)

	var data metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &data); err != nil {
		t.Fatalf("Collect: %v", err)
	}
	histData, ok := data.ScopeMetrics[0].Metrics[0].Data.(metricdata.Histogram[float64])
	if !ok {
		t.Fatalf("data is %T, want Histogram[float64]", data.ScopeMetrics[0].Metrics[0].Data)
	}
	got := histData.DataPoints[0].Bounds
	if len(got) != len(buckets) {
		t.Fatalf("bounds = %v, want %v", got, buckets)
	}
	for i := range buckets {
		if got[i] != buckets[i] {
			t.Fatalf("bounds = %v, want %v", got, buckets)
		}
	}
}

func TestShutdownIdempotent(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("shutdown-test"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(recorder),
		o11y.WithMetricReader(sdkmetric.NewManualReader()),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
	)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	first := sdk.Shutdown(context.Background())
	second := sdk.Shutdown(context.Background())
	if first != nil || second != nil {
		t.Errorf("Shutdown errors: first=%v second=%v, want nil/nil", first, second)
	}
}

func TestForceFlush(t *testing.T) {
	sdk, _, _, _ := newHermetic(t)
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Errorf("ForceFlush: %v", err)
	}
}

func TestSpansEndAfterShutdownAreDropped(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("post-shutdown"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(recorder),
		o11y.WithMetricReader(sdkmetric.NewManualReader()),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
	)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := sdk.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	// Telemetry after shutdown must be inert, never a panic or error.
	_, span := sdk.TracerProvider().Tracer("test").Start(context.Background(), "late")
	span.End()
	sdk.Logger().Info("late log")
}

func TestAttrReplacerAppliedToConsole(t *testing.T) {
	sdk, _, _, console := newHermetic(t, o11y.WithAttrReplacer(
		func(_ []string, attr slog.Attr) slog.Attr {
			if attr.Key == "password" {
				attr.Value = slog.StringValue("REDACTED")
			}
			return attr
		},
	))
	sdk.Logger().Info("login", "password", "hunter2", "user", "gopher")

	records := consoleRecords(t, console)
	if got := records[0]["password"]; got != "REDACTED" {
		t.Errorf("password = %v, want REDACTED", got)
	}
	if got := records[0]["user"]; got != "gopher" {
		t.Errorf("user = %v, want gopher", got)
	}
}
