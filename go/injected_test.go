package o11y_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

// shutdownCounter counts Shutdown calls on an injected part.
type shutdownCounter struct{ n atomic.Int32 }

func (c *shutdownCounter) count(context.Context) error {
	c.n.Add(1)
	return nil
}

type countedSpanExporter struct{ *shutdownCounter }

func (countedSpanExporter) ExportSpans(context.Context, []sdktrace.ReadOnlySpan) error { return nil }
func (e countedSpanExporter) Shutdown(ctx context.Context) error                       { return e.count(ctx) }

type countedLogExporter struct{ *shutdownCounter }

func (countedLogExporter) Export(context.Context, []sdklog.Record) error { return nil }
func (countedLogExporter) ForceFlush(context.Context) error              { return nil }
func (e countedLogExporter) Shutdown(ctx context.Context) error          { return e.count(ctx) }

type countedMetricExporter struct{ *shutdownCounter }

func (countedMetricExporter) Temporality(k sdkmetric.InstrumentKind) metricdata.Temporality {
	return sdkmetric.DefaultTemporalitySelector(k)
}

func (countedMetricExporter) Aggregation(k sdkmetric.InstrumentKind) sdkmetric.Aggregation {
	return sdkmetric.DefaultAggregationSelector(k)
}

func (countedMetricExporter) Export(context.Context, *metricdata.ResourceMetrics) error {
	return nil
}
func (countedMetricExporter) ForceFlush(context.Context) error     { return nil }
func (e countedMetricExporter) Shutdown(ctx context.Context) error { return e.count(ctx) }

// injectedParts is one of every part an option can inject, each counting
// its Shutdown calls.
type injectedParts struct {
	spanExp, logExp, metricExp shutdownCounter
	proc                       *countingProcessor
}

func (p *injectedParts) options(interval time.Duration) []o11y.Option {
	p.proc = &countingProcessor{}
	return []o11y.Option{
		o11y.WithSpanProcessor(p.proc),
		o11y.WithTraceExporter(countedSpanExporter{&p.spanExp}),
		o11y.WithLogExporter(countedLogExporter{&p.logExp}),
		o11y.WithMetricReader(sdkmetric.NewPeriodicReader(countedMetricExporter{&p.metricExp},
			sdkmetric.WithInterval(interval))),
	}
}

// assertEachShutOnce checks every injected part was shut down exactly once.
func (p *injectedParts) assertEachShutOnce(t *testing.T) {
	t.Helper()
	for name, n := range map[string]int32{
		"span processor":  p.proc.shutdowns.Load(),
		"span exporter":   p.spanExp.n.Load(),
		"log exporter":    p.logExp.n.Load(),
		"metric exporter": p.metricExp.n.Load(),
	} {
		if n != 1 {
			t.Errorf("injected %s Shutdown ran %d times, want exactly once", name, n)
		}
	}
}

// countGlobalErrors installs a global OpenTelemetry error handler that
// counts reports of an unregistered reader, restoring the previous one.
func countGlobalErrors(t *testing.T) *atomic.Int32 {
	t.Helper()
	var n atomic.Int32
	prev := otel.GetErrorHandler()
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		if errors.Is(err, sdkmetric.ErrReaderNotRegistered) {
			n.Add(1)
		}
	}))
	t.Cleanup(func() { otel.SetErrorHandler(prev) })
	return &n
}

// TestSDKDisabledOwnsInjectedParts pins that while OTEL_SDK_DISABLED
// switches the SDK off, it still owns what options injected: each part is
// shut down exactly once, and an injected periodic reader never reports
// that it is not registered, during the run or after Shutdown.
func TestSDKDisabledOwnsInjectedParts(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "true")
	notRegistered := countGlobalErrors(t)
	const interval = 5 * time.Millisecond

	var parts injectedParts
	sdk, err := o11y.New(context.Background(), append(parts.options(interval),
		o11y.WithServiceName("disabled-owns"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutConsoleLog(),
	)...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Several intervals pass while the SDK runs. A reader left running
	// unregistered would report on each of them.
	time.Sleep(12 * interval)
	if err := sdk.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown: %v", err)
	}
	parts.assertEachShutOnce(t)
	time.Sleep(12 * interval)
	if n := notRegistered.Load(); n != 0 {
		t.Errorf("the injected reader reported %d times that it is not registered, want 0", n)
	}
}

// TestFailedNewShutsDownInjectedParts pins that a New that fails, at any
// stage, shuts down every part options injected exactly once: before any
// provider exists, while the metric reader is built from the environment,
// and after the providers exist.
func TestFailedNewShutsDownInjectedParts(t *testing.T) {
	for _, tc := range []struct {
		name string
		env  map[string]string
		opts []o11y.Option
	}{
		{name: "invalid environment", opts: []o11y.Option{o11y.WithEnvironment("nowhere")}},
		{name: "unknown propagator", env: map[string]string{"OTEL_PROPAGATORS": "bogus"}},
		{
			name: "disabled, invalid environment", env: map[string]string{"OTEL_SDK_DISABLED": "true"},
			opts: []o11y.Option{o11y.WithEnvironment("nowhere")},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			var parts injectedParts
			opts := append(parts.options(time.Hour),
				o11y.WithServiceName("failed-new"),
				o11y.WithEnvironment(spec.EnvironmentTest),
				o11y.WithoutConsoleLog(),
			)
			if _, err := o11y.New(context.Background(), append(opts, tc.opts...)...); err == nil {
				t.Fatal("New succeeded, want an error")
			}
			parts.assertEachShutOnce(t)
		})
	}
}

// TestFailedNewWhileBuildingReaderShutsDownInjectedParts covers a failure
// while the metric reader is built from the environment: the span
// processor, span exporter, and log exporter injected in code are not yet
// registered anywhere, and must still be shut down.
func TestFailedNewWhileBuildingReaderShutsDownInjectedParts(t *testing.T) {
	t.Setenv("OTEL_METRICS_EXPORTER", "bogus")
	var spanExp, logExp shutdownCounter
	proc := &countingProcessor{}
	_, err := o11y.New(context.Background(),
		o11y.WithServiceName("failed-reader"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutConsoleLog(),
		o11y.WithSpanProcessor(proc),
		o11y.WithTraceExporter(countedSpanExporter{&spanExp}),
		o11y.WithLogExporter(countedLogExporter{&logExp}),
	)
	if err == nil {
		t.Fatal("New with OTEL_METRICS_EXPORTER=bogus succeeded, want an error")
	}
	for name, n := range map[string]int32{
		"span processor": proc.shutdowns.Load(),
		"span exporter":  spanExp.n.Load(),
		"log exporter":   logExp.n.Load(),
	} {
		if n != 1 {
			t.Errorf("injected %s Shutdown ran %d times, want exactly once", name, n)
		}
	}
}

// TestUnusedLogExporterIsShutDown pins that a log exporter injected and
// then switched off by WithoutLogExport is still owned and shut down.
func TestUnusedLogExporterIsShutDown(t *testing.T) {
	var logExp shutdownCounter
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("unused-log-exporter"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutOTELEnv(),
		o11y.WithoutConsoleLog(),
		o11y.WithLogExporter(countedLogExporter{&logExp}),
		o11y.WithoutLogExport(),
	)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := sdk.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown: %v", err)
	}
	if n := logExp.n.Load(); n != 1 {
		t.Errorf("unused log exporter Shutdown ran %d times, want exactly once", n)
	}
}

// TestSetupAlreadySetupShutsDownInjectedParts pins that a Setup that loses
// to an installed SDK still owns what its options injected: each part is
// shut down exactly once, its periodic reader never reports that it is not
// registered, and the installed SDK is left alone.
func TestSetupAlreadySetupShutsDownInjectedParts(t *testing.T) {
	restoreGlobals(t)
	installed, err := o11y.Setup(context.Background(), hermeticOptions("installed")...)
	if err != nil {
		t.Fatalf("first Setup: %v", err)
	}
	notRegistered := countGlobalErrors(t)
	const interval = 5 * time.Millisecond

	var parts injectedParts
	_, err = o11y.Setup(context.Background(), append(parts.options(interval),
		o11y.WithServiceName("second"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutConsoleLog(),
	)...)
	if !errors.Is(err, o11y.ErrAlreadySetup) {
		t.Fatalf("second Setup = %v, want ErrAlreadySetup", err)
	}
	parts.assertEachShutOnce(t)
	time.Sleep(12 * interval)
	if n := notRegistered.Load(); n != 0 {
		t.Errorf("the losing Setup's reader reported %d times that it is not registered, want 0", n)
	}
	if err := installed.Shutdown(context.Background()); err != nil {
		t.Errorf("installed SDK Shutdown: %v", err)
	}
}
