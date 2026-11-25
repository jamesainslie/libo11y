package o11y_test

import (
	"context"
	"errors"
	"log/slog"
	"strings"
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

// errRejected stands in for a collector answering 400 to every export.
var errRejected = errors.New("collector rejected the export")

// failGate fails the exports it is told to: every export when always is
// set, otherwise only the first.
type failGate struct {
	always bool
	calls  atomic.Int32
}

func (g *failGate) export() error {
	if n := g.calls.Add(1); g.always || n == 1 {
		return errRejected
	}
	return nil
}

type failingSpanExporter struct{ *failGate }

func (e failingSpanExporter) ExportSpans(context.Context, []sdktrace.ReadOnlySpan) error {
	return e.export()
}
func (failingSpanExporter) Shutdown(context.Context) error { return nil }

type failingLogExporter struct{ *failGate }

func (e failingLogExporter) Export(context.Context, []sdklog.Record) error { return e.export() }
func (failingLogExporter) Shutdown(context.Context) error                  { return nil }
func (failingLogExporter) ForceFlush(context.Context) error                { return nil }

type failingMetricExporter struct{ *failGate }

func (failingMetricExporter) Temporality(k sdkmetric.InstrumentKind) metricdata.Temporality {
	return sdkmetric.DefaultTemporalitySelector(k)
}

func (failingMetricExporter) Aggregation(k sdkmetric.InstrumentKind) sdkmetric.Aggregation {
	return sdkmetric.DefaultAggregationSelector(k)
}

func (e failingMetricExporter) Export(context.Context, *metricdata.ResourceMetrics) error {
	return e.export()
}
func (failingMetricExporter) ForceFlush(context.Context) error { return nil }
func (failingMetricExporter) Shutdown(context.Context) error   { return nil }

// droppedEvents records the signal of every o11y.telemetry.dropped event.
type droppedEvents struct {
	mu      sync.Mutex
	signals []string
}

func (*droppedEvents) Enabled(context.Context, slog.Level) bool { return true }
func (d *droppedEvents) Handle(_ context.Context, r slog.Record) error {
	if r.Message != spec.EventTelemetryDropped {
		return nil
	}
	r.Attrs(func(a slog.Attr) bool {
		if a.Key == string(spec.SignalKey) {
			d.mu.Lock()
			d.signals = append(d.signals, a.Value.String())
			d.mu.Unlock()
		}
		return true
	})
	return nil
}
func (d *droppedEvents) WithAttrs([]slog.Attr) slog.Handler { return d }
func (d *droppedEvents) WithGroup(string) slog.Handler      { return d }

func (d *droppedEvents) has(signal string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, s := range d.signals {
		if s == signal {
			return true
		}
	}
	return false
}

// failingSignal builds an SDK whose exporter for one signal fails, and
// emits n items on that signal.
type failingSignal struct {
	signal string
	opt    func(*failGate) o11y.Option
	emit   func(t *testing.T, sdk *o11y.SDK, n int)
}

var failingSignals = []failingSignal{
	{
		signal: "traces",
		opt:    func(g *failGate) o11y.Option { return o11y.WithTraceExporter(failingSpanExporter{g}) },
		emit: func(_ *testing.T, sdk *o11y.SDK, n int) {
			tracer := sdk.TracerProvider().Tracer("t")
			for range n {
				_, span := tracer.Start(context.Background(), "op")
				span.End()
			}
		},
	},
	{
		signal: "logs",
		opt:    func(g *failGate) o11y.Option { return o11y.WithLogExporter(failingLogExporter{g}) },
		emit: func(_ *testing.T, sdk *o11y.SDK, n int) {
			for range n {
				sdk.Logger().Info("record")
			}
		},
	},
	{
		signal: "metrics",
		opt: func(g *failGate) o11y.Option {
			return o11y.WithMetricReader(sdkmetric.NewPeriodicReader(failingMetricExporter{g}))
		},
		emit: func(t *testing.T, sdk *o11y.SDK, n int) {
			c, err := sdk.MeterProvider().Meter("t").Int64Counter("c")
			if err != nil {
				t.Fatal(err)
			}
			c.Add(context.Background(), int64(n))
		},
	},
}

func newFailingSDK(t *testing.T, fs failingSignal, gate *failGate, dropped *droppedEvents) *o11y.SDK {
	t.Helper()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("export-fail"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutOTELEnv(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
		o11y.WithExtraLogHandler(dropped),
		o11y.WithErrorHandler(func(error) {}),
		fs.opt(gate),
	)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return sdk
}

func assertSignalFailure(t *testing.T, err error, phase, signal string) {
	t.Helper()
	if !errors.Is(err, errRejected) {
		t.Errorf("%s error = %v, want it to wrap the exporter's error", phase, err)
	}
	if want := "o11y: " + phase + " " + signal; err == nil || !strings.Contains(err.Error(), want) {
		t.Errorf("%s error = %v, want it to name %q", phase, err, want)
	}
}

// TestShutdownReportsRejectedFinalExport pins that a final export the
// collector rejects during Shutdown is reported in the returned error, per
// signal, and as an o11y.telemetry.dropped event.
//
// Only the traces case proves the fix: the batch span processor drains its
// queue during Shutdown and used to hand the failure to the error handler
// alone. The logs and metrics cases passed before the fix, because their
// processors return the final export's error; they stay as regression
// guards for that behaviour and do not by themselves prove the fix.
func TestShutdownReportsRejectedFinalExport(t *testing.T) {
	for _, fs := range failingSignals {
		t.Run(fs.signal, func(t *testing.T) {
			dropped := &droppedEvents{}
			sdk := newFailingSDK(t, fs, &failGate{always: true}, dropped)
			fs.emit(t, sdk, 1)
			err := sdk.Shutdown(context.Background())
			assertSignalFailure(t, err, "shutdown", fs.signal)
			if !dropped.has(fs.signal) {
				t.Errorf("no o11y.telemetry.dropped event for %s", fs.signal)
			}
		})
	}
}

// TestForceFlushReportsRejectedExport pins that ForceFlush reports an
// export the collector rejects during the call, on every signal.
//
// This test passed before the fix on every signal: each processor returns
// the error of the final export it runs inside ForceFlush. It is a
// regression guard for that behaviour and does not by itself prove the
// fix; TestForceFlushReportsBatchExportFailedDuringCall does.
func TestForceFlushReportsRejectedExport(t *testing.T) {
	for _, fs := range failingSignals {
		t.Run(fs.signal, func(t *testing.T) {
			sdk := newFailingSDK(t, fs, &failGate{always: true}, &droppedEvents{})
			t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
			fs.emit(t, sdk, 1)
			err := sdk.ForceFlush(context.Background())
			assertSignalFailure(t, err, "flush", fs.signal)
		})
	}
}

// windowGate fails the first export, but only once a Shutdown or
// ForceFlush has started recording failures, and lets every later export
// succeed. The first export runs on the batch processor's own goroutine,
// so without the wait it could fail before the call began.
type windowGate struct {
	signal string
	sdk    atomic.Pointer[o11y.SDK]
	calls  atomic.Int32
}

// export waits, on its first call, until the SDK reports an open window
// for the gate's signal (polling, since the window is not a channel), then
// fails. A missing window ends the wait after five seconds, so a broken
// window fails the test instead of hanging it.
func (g *windowGate) export() error {
	if g.calls.Add(1) != 1 {
		return nil
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if sdk := g.sdk.Load(); sdk != nil && sdk.ExportWindowOpen(g.signal) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	return errRejected
}

type windowSpanExporter struct{ *windowGate }

func (e windowSpanExporter) ExportSpans(context.Context, []sdktrace.ReadOnlySpan) error {
	return e.export()
}
func (windowSpanExporter) Shutdown(context.Context) error { return nil }

type windowLogExporter struct{ *windowGate }

func (e windowLogExporter) Export(context.Context, []sdklog.Record) error { return e.export() }
func (windowLogExporter) Shutdown(context.Context) error                  { return nil }
func (windowLogExporter) ForceFlush(context.Context) error                { return nil }

// TestForceFlushReportsBatchExportFailedDuringCall covers the gap the batch
// processors leave: more items than one batch holds are emitted, so the
// processor exports a full batch from its own goroutine and hands that
// failure to the error handler, while the final export ForceFlush runs
// itself succeeds. The failure happened during the call, so the call must
// report it.
func TestForceFlushReportsBatchExportFailedDuringCall(t *testing.T) {
	for _, tc := range []struct {
		signal string
		opt    func(*windowGate) o11y.Option
		emit   func(*o11y.SDK)
	}{
		{
			signal: "traces",
			opt:    func(g *windowGate) o11y.Option { return o11y.WithTraceExporter(windowSpanExporter{g}) },
			emit: func(sdk *o11y.SDK) {
				for range 513 {
					_, span := sdk.TracerProvider().Tracer("t").Start(context.Background(), "op")
					span.End()
				}
			},
		},
		{
			signal: "logs",
			opt:    func(g *windowGate) o11y.Option { return o11y.WithLogExporter(windowLogExporter{g}) },
			emit: func(sdk *o11y.SDK) {
				for range 513 {
					sdk.Logger().Info("record")
				}
			},
		},
	} {
		t.Run(tc.signal, func(t *testing.T) {
			gate := &windowGate{signal: tc.signal}
			sdk, err := o11y.New(context.Background(),
				o11y.WithServiceName("export-window"),
				o11y.WithEnvironment(spec.EnvironmentTest),
				o11y.WithoutOTELEnv(),
				o11y.WithoutRuntimeMetrics(),
				o11y.WithoutConsoleLog(),
				o11y.WithErrorHandler(func(error) {}),
				tc.opt(gate),
			)
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			gate.sdk.Store(sdk)
			t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
			tc.emit(sdk)
			assertSignalFailure(t, sdk.ForceFlush(context.Background()), "flush", tc.signal)
		})
	}
}

// TestForceFlushWindowEndsWithTheCall pins that a failure is reported only
// by the call during which it happened: a later, clean ForceFlush returns
// nil.
//
// It passed before the fix too, since nothing was recorded then. It guards
// the window's end: a failure must not leak into a later call. It does
// not by itself prove the fix.
func TestForceFlushWindowEndsWithTheCall(t *testing.T) {
	for _, fs := range failingSignals {
		t.Run(fs.signal, func(t *testing.T) {
			sdk := newFailingSDK(t, fs, &failGate{}, &droppedEvents{})
			t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
			fs.emit(t, sdk, 1)
			if err := sdk.ForceFlush(context.Background()); !errors.Is(err, errRejected) {
				t.Fatalf("first ForceFlush = %v, want the rejection", err)
			}
			fs.emit(t, sdk, 1)
			if err := sdk.ForceFlush(context.Background()); err != nil {
				t.Errorf("second ForceFlush = %v, want nil once exports succeed", err)
			}
		})
	}
}
