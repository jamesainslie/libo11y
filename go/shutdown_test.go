package o11y_test

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	o11y "github.com/jamesainslie/libo11y/go"
)

// hangingLogExporter blocks every export until its context ends.
type hangingLogExporter struct{}

func (hangingLogExporter) Export(ctx context.Context, _ []sdklog.Record) error {
	<-ctx.Done()
	return ctx.Err()
}
func (hangingLogExporter) Shutdown(context.Context) error   { return nil }
func (hangingLogExporter) ForceFlush(context.Context) error { return nil }

// announcedHangingLogExporter is a hangingLogExporter that closes entered
// when its first export starts, so a test knows the flush is under way.
type announcedHangingLogExporter struct {
	hangingLogExporter
	entered chan struct{}
	once    *sync.Once
}

func (e announcedHangingLogExporter) Export(ctx context.Context, records []sdklog.Record) error {
	e.once.Do(func() { close(e.entered) })
	return e.hangingLogExporter.Export(ctx, records)
}

// keptSpanExporter is an in-memory span exporter whose Shutdown keeps the
// recorded spans; tracetest.InMemoryExporter clears them on Shutdown, which
// would hide what the trace flush delivered.
type keptSpanExporter struct {
	*tracetest.InMemoryExporter
}

func (keptSpanExporter) Shutdown(context.Context) error { return nil }

func TestHungLogExportDoesNotStarveTraces(t *testing.T) {
	t.Parallel()
	spans := tracetest.NewInMemoryExporter()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("shutdown"), o11y.WithEnvironment("test"),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics(),
		o11y.WithLogExporter(hangingLogExporter{}), o11y.WithTraceExporter(keptSpanExporter{spans}))
	if err != nil {
		t.Fatal(err)
	}
	sdk.Logger().Info("stuck")
	_, span := sdk.TracerProvider().Tracer("t").Start(context.Background(), "op")
	span.End()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	start := time.Now()
	err = sdk.Shutdown(ctx)
	// The bound is wide on purpose: it only catches a Shutdown that ignores
	// its deadline and hangs, not a slow machine.
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("Shutdown took %v, want it bounded by the 1s deadline", elapsed)
	}
	if err == nil {
		t.Error("Shutdown returned nil despite the hung log export")
	} else {
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("Shutdown error = %v, want it to wrap DeadlineExceeded", err)
		}
		if !strings.Contains(err.Error(), "shutdown logs") {
			t.Errorf("Shutdown error = %q, want it to name the logs signal", err)
		}
	}
	if n := len(spans.GetSpans()); n != 1 {
		t.Errorf("traces exported %d spans, want 1: a hung log exporter starved the trace flush", n)
	}
}

func TestConcurrentShutdownHonorsEachCallersDeadline(t *testing.T) {
	t.Parallel()
	exporter := announcedHangingLogExporter{entered: make(chan struct{}), once: new(sync.Once)}
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("shutdown2"), o11y.WithEnvironment("test"),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics(),
		o11y.WithLogExporter(exporter))
	if err != nil {
		t.Fatal(err)
	}
	sdk.Logger().Info("stuck")
	// The first caller's deadline (20s) is past the second caller's bound
	// (10s), so a second caller that waited on the first instead of honoring
	// its own deadline still fails the bound. The first caller is cancelled as
	// soon as the second returns, so the test does not wait out 20s.
	firstCtx, cancelFirst := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelFirst()
	first := make(chan error, 1)
	go func() { first <- sdk.Shutdown(firstCtx) }()
	<-exporter.entered // a flush is under way, so the log export is stuck
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	err = sdk.Shutdown(ctx)
	// The bound is wide on purpose: it only catches a hang, not a slow machine.
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Errorf("second caller waited %v despite a 100ms deadline", elapsed)
	}
	cancelFirst()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("second caller error = %v, want DeadlineExceeded", err)
	}
	if firstErr := <-first; firstErr == nil {
		t.Error("first caller's Shutdown returned nil despite the hung log export")
	}
}

func TestShutdownAfterCompletionIgnoresCallerContext(t *testing.T) {
	t.Parallel()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("shutdown3"), o11y.WithEnvironment("test"),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics())
	if err != nil {
		t.Fatal(err)
	}
	want := sdk.Shutdown(context.Background())
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	for i := range 20 {
		if got := sdk.Shutdown(cancelled); got != want { //nolint:errorlint // the identical stored result is expected
			t.Fatalf("call %d after completion returned %v, want the shutdown result %v", i, got, want)
		}
	}
}

// stuckSpanProcessor is a span processor whose Shutdown ignores its context:
// it signals entered and then blocks until release is closed.
type stuckSpanProcessor struct {
	sdktrace.SpanProcessor
	entered chan struct{}
	release chan struct{}
}

func (p stuckSpanProcessor) Shutdown(context.Context) error {
	close(p.entered)
	<-p.release
	return nil
}

// refusingAfterDone is a log sink that, like many handlers, refuses a record
// whose context has ended. It records the signal of each dropped event it
// accepts.
type refusingAfterDone struct{ droppedEvents }

func (h *refusingAfterDone) Handle(ctx context.Context, r slog.Record) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return h.droppedEvents.Handle(ctx, r)
}
func (h *refusingAfterDone) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *refusingAfterDone) WithGroup(string) slog.Handler      { return h }

// A part that ignores its context must not hold Shutdown past the caller's
// deadline. Shutdown returns when the context ends, with an error that
// names the unfinished signal, and every later call returns that same
// result. The dropped event for that signal still reaches a sink that
// refuses records on an ended context, because the event is the notice
// that the deadline was missed.
func TestShutdownReturnsWhenAPartIgnoresTheContext(t *testing.T) {
	t.Parallel()
	stuck := stuckSpanProcessor{
		SpanProcessor: tracetest.NewSpanRecorder(),
		entered:       make(chan struct{}),
		release:       make(chan struct{}),
	}
	t.Cleanup(func() { close(stuck.release) })
	sink := &refusingAfterDone{}
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("shutdown4"), o11y.WithEnvironment("test"),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics(),
		o11y.WithSpanProcessor(stuck), o11y.WithExtraLogHandler(sink))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- sdk.Shutdown(ctx) }()
	<-stuck.entered
	cancel()

	select {
	case err = <-done:
	case <-time.After(30 * time.Second): // a failsafe, not a synchronisation point
		t.Fatal("Shutdown is still waiting on a part that ignores its cancelled context")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("Shutdown error = %v, want it to wrap context.Canceled", err)
	}
	if err == nil || !strings.Contains(err.Error(), "shutdown traces: did not finish") {
		t.Errorf("Shutdown error = %v, want it to report traces as unfinished", err)
	}
	if again := sdk.Shutdown(context.Background()); again != err { //nolint:errorlint // the identical stored result is expected
		t.Errorf("a later Shutdown returned %v, want the first result %v", again, err)
	}
	if !sink.has("traces") {
		t.Error("no o11y.telemetry.dropped event for traces reached a sink that refuses an ended context")
	}
	if got, want := sink.errorType("traces"), "*errors.errorString"; got != want {
		t.Errorf("dropped event error.type = %q, want %q (context.Canceled)", got, want)
	}
}

// A signal that runs out of time under a deadline reports its own error:
// the signals stop a little ahead of the caller's deadline, so Shutdown is
// still waiting when the signal returns.
func TestShutdownReportsTheSignalsOwnDeadlineError(t *testing.T) {
	t.Parallel()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("shutdown5"), o11y.WithEnvironment("test"),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics(),
		o11y.WithLogExporter(hangingLogExporter{}))
	if err != nil {
		t.Fatal(err)
	}
	sdk.Logger().Info("stuck")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err = sdk.Shutdown(ctx)
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "shutdown logs") {
		t.Fatalf("Shutdown error = %v, want the logs signal's deadline error", err)
	}
	if strings.Contains(err.Error(), "did not finish") {
		t.Errorf("Shutdown error = %v, want the exporter's own error, not an unfinished signal", err)
	}
}
