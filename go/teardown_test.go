package o11y_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

// promptly bounds how long a failed New or Setup may take to tear down a
// partly built pipeline. The blocking exporters below would hold a flush
// for seconds (or forever) if teardown handed them a live context.
const promptly = time.Second

// blocker stands in for an exporter whose collector is unreachable: every
// call blocks until its context is done. shut is closed on the first
// Shutdown call, so a test can see that the pipeline really stopped.
type blocker struct {
	once sync.Once
	shut chan struct{}
}

func newBlocker() *blocker { return &blocker{shut: make(chan struct{})} }

func (b *blocker) wait(ctx context.Context) error {
	<-ctx.Done()
	return ctx.Err()
}

func (b *blocker) shutdown(ctx context.Context) error {
	b.once.Do(func() { close(b.shut) })
	return b.wait(ctx)
}

// awaitShutdown fails the test unless the exporter's Shutdown was called.
func (b *blocker) awaitShutdown(t *testing.T, what string) {
	t.Helper()
	select {
	case <-b.shut:
	case <-time.After(promptly):
		t.Errorf("%s: exporter Shutdown never called, so its pipeline was not stopped", what)
	}
}

type blockingMetricExporter struct{ *blocker }

func (blockingMetricExporter) Temporality(k sdkmetric.InstrumentKind) metricdata.Temporality {
	return sdkmetric.DefaultTemporalitySelector(k)
}

func (blockingMetricExporter) Aggregation(k sdkmetric.InstrumentKind) sdkmetric.Aggregation {
	return sdkmetric.DefaultAggregationSelector(k)
}

func (e blockingMetricExporter) Export(ctx context.Context, _ *metricdata.ResourceMetrics) error {
	return e.wait(ctx)
}
func (e blockingMetricExporter) ForceFlush(ctx context.Context) error { return e.wait(ctx) }
func (e blockingMetricExporter) Shutdown(ctx context.Context) error   { return e.shutdown(ctx) }

type blockingSpanExporter struct{ *blocker }

func (e blockingSpanExporter) ExportSpans(ctx context.Context, _ []sdktrace.ReadOnlySpan) error {
	return e.wait(ctx)
}
func (e blockingSpanExporter) Shutdown(ctx context.Context) error { return e.shutdown(ctx) }

type blockingLogExporter struct{ *blocker }

func (e blockingLogExporter) Export(ctx context.Context, _ []sdklog.Record) error {
	return e.wait(ctx)
}
func (e blockingLogExporter) ForceFlush(ctx context.Context) error { return e.wait(ctx) }
func (e blockingLogExporter) Shutdown(ctx context.Context) error   { return e.shutdown(ctx) }

// timed runs fn in a goroutine and returns its error and duration, failing
// the test if fn has not returned well past the promptness bound.
func timed(t *testing.T, fn func() error) (time.Duration, error) {
	t.Helper()
	done := make(chan error, 1)
	start := time.Now()
	go func() { done <- fn() }()
	select {
	case err := <-done:
		return time.Since(start), err
	case <-time.After(3 * promptly):
		t.Fatalf("still blocked after %v tearing down a failed construction", 3*promptly)
		return 0, nil
	}
}

// TestNewFailureDoesNotFlushMeterProvider is the reported reproduction: a
// failure after the meter provider exists used to shut it down with the
// caller's deadline-free context, so the periodic reader's final export
// waited out its 30 second timeout.
func TestNewFailureDoesNotFlushMeterProvider(t *testing.T) {
	t.Setenv("OTEL_TRACES_EXPORTER", "bogus")
	metrics := blockingMetricExporter{newBlocker()}

	took, err := timed(t, func() error {
		_, err := o11y.New(context.Background(),
			o11y.WithServiceName("teardown-metrics"),
			o11y.WithEnvironment(spec.EnvironmentTest),
			o11y.WithMetricReader(sdkmetric.NewPeriodicReader(metrics)),
			o11y.WithoutRuntimeMetrics(),
			o11y.WithoutLogExport(),
			o11y.WithoutConsoleLog(),
		)
		return err
	})
	if err == nil {
		t.Fatal("New with OTEL_TRACES_EXPORTER=bogus succeeded, want an error")
	}
	if took > promptly {
		t.Errorf("New took %v to fail, want under %v", took, promptly)
	}
	metrics.awaitShutdown(t, "metrics")
}

// TestNewFailureDoesNotFlushTracerProvider covers a failure after both the
// meter and tracer providers exist.
func TestNewFailureDoesNotFlushTracerProvider(t *testing.T) {
	t.Setenv("OTEL_LOGS_EXPORTER", "bogus")
	metrics := blockingMetricExporter{newBlocker()}
	spans := blockingSpanExporter{newBlocker()}

	took, err := timed(t, func() error {
		_, err := o11y.New(context.Background(),
			o11y.WithServiceName("teardown-traces"),
			o11y.WithEnvironment(spec.EnvironmentTest),
			o11y.WithMetricReader(sdkmetric.NewPeriodicReader(metrics)),
			o11y.WithTraceExporter(spans),
			o11y.WithoutRuntimeMetrics(),
			o11y.WithoutConsoleLog(),
		)
		return err
	})
	if err == nil {
		t.Fatal("New with OTEL_LOGS_EXPORTER=bogus succeeded, want an error")
	}
	if took > promptly {
		t.Errorf("New took %v to fail, want under %v", took, promptly)
	}
	metrics.awaitShutdown(t, "metrics")
	spans.awaitShutdown(t, "traces")
}

// TestSetupCanaryRejectionDoesNotFlush pins that a canary rejection tears
// the pipeline down without waiting on any exporter, and frees the guard.
func TestSetupCanaryRejectionDoesNotFlush(t *testing.T) {
	restoreGlobals(t)
	metrics := blockingMetricExporter{newBlocker()}
	spans := blockingSpanExporter{newBlocker()}
	logs := blockingLogExporter{newBlocker()}
	sinkErr := errors.New("sink rejects records")

	took, err := timed(t, func() error {
		_, err := o11y.Setup(context.Background(),
			o11y.WithServiceName("teardown-canary"),
			o11y.WithEnvironment(spec.EnvironmentTest),
			o11y.WithMetricReader(sdkmetric.NewPeriodicReader(metrics)),
			o11y.WithTraceExporter(spans),
			o11y.WithLogExporter(logs),
			o11y.WithoutRuntimeMetrics(),
			o11y.WithoutConsoleLog(),
			o11y.WithExtraLogHandler(failingSink{err: sinkErr}),
		)
		return err
	})
	if !errors.Is(err, sinkErr) {
		t.Fatalf("Setup: err = %v, want the sink's error", err)
	}
	if took > promptly {
		t.Errorf("Setup took %v to fail, want under %v", took, promptly)
	}
	metrics.awaitShutdown(t, "metrics")
	spans.awaitShutdown(t, "traces")
	logs.awaitShutdown(t, "logs")

	sdk, err := o11y.Setup(context.Background(), hermeticOptions("after-canary-teardown")...)
	if err != nil {
		t.Fatalf("Setup after canary rejection: %v", err)
	}
	if err := sdk.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown: %v", err)
	}
}

// countingProcessor counts its Shutdown calls and, when panics is set,
// panics from Shutdown, standing in for faulty user code.
type countingProcessor struct {
	shutdowns atomic.Int32
	panics    bool
}

func (*countingProcessor) OnStart(context.Context, sdktrace.ReadWriteSpan) {}
func (*countingProcessor) OnEnd(sdktrace.ReadOnlySpan)                     {}
func (*countingProcessor) ForceFlush(context.Context) error                { return nil }
func (p *countingProcessor) Shutdown(context.Context) error {
	p.shutdowns.Add(1)
	if p.panics {
		panic("processor shutdown exploded")
	}
	return nil
}

// TestNewFailureStopsInjectedProcessorOnce pins that a failed New stops a
// WithSpanProcessor processor exactly once, and that a panic from its
// Shutdown does not escape New, which returns the construction error.
func TestNewFailureStopsInjectedProcessorOnce(t *testing.T) {
	for _, panics := range []bool{false, true} {
		t.Run(fmt.Sprintf("panics=%t", panics), func(t *testing.T) {
			t.Setenv("OTEL_LOGS_EXPORTER", "bogus")
			proc := &countingProcessor{panics: panics}
			var err error
			noPanic(t, "New", func() {
				_, err = o11y.New(context.Background(),
					o11y.WithServiceName("teardown-once"),
					o11y.WithEnvironment(spec.EnvironmentTest),
					o11y.WithSpanProcessor(proc),
					o11y.WithMetricReader(sdkmetric.NewManualReader()),
					o11y.WithoutRuntimeMetrics(),
					o11y.WithoutConsoleLog(),
				)
			})
			if err == nil {
				t.Fatal("New with OTEL_LOGS_EXPORTER=bogus succeeded, want an error")
			}
			if n := proc.shutdowns.Load(); n != 1 {
				t.Errorf("processor Shutdown ran %d times, want exactly once", n)
			}
		})
	}
}

// TestSetupPanicSurvivesPanickingTeardown pins that a second panic from
// user code while Setup abandons its pipeline does not replace the panic
// already unwinding through Setup.
func TestSetupPanicSurvivesPanickingTeardown(t *testing.T) {
	restoreGlobals(t)
	proc := &countingProcessor{panics: true}
	recovered := func() (r any) {
		defer func() { r = recover() }()
		opts := append(hermeticOptions("setup-panic-stop"),
			o11y.WithSpanProcessor(proc), o11y.WithExtraLogHandler(panickingSink{}))
		_, _ = o11y.Setup(context.Background(), opts...)
		return nil
	}()
	if recovered != "sink exploded" {
		t.Errorf("Setup recovered %v, want the sink's panic", recovered)
	}
	if n := proc.shutdowns.Load(); n != 1 {
		t.Errorf("processor Shutdown ran %d times, want exactly once", n)
	}
}
