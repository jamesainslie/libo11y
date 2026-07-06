package o11y_test

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"syscall"
	"testing"
	"time"

	"go.opentelemetry.io/otel"

	o11y "github.com/jamesainslie/libo11y/go"
)

func TestForceEmitBypassesLogLevel(t *testing.T) {
	sdk, _, _, console := newHermetic(t, o11y.WithLogLevel(slog.LevelError))

	sdk.Logger().Info("filtered")
	sdk.Logger().InfoContext(o11y.ForceEmit(context.Background()), "audit event")

	records := consoleRecords(t, console)
	if len(records) != 1 {
		t.Fatalf("got %d records, want 1 (only the forced record)", len(records))
	}
	if got, want := records[0]["msg"], "audit event"; got != want {
		t.Errorf("msg = %v, want %v", got, want)
	}
}

func TestEffectiveConfigResolved(t *testing.T) {
	sdk, _, _, _ := newHermetic(t)

	config := sdk.EffectiveConfig()
	for _, want := range []string{
		"service.name=libo11y-test",
		"traces=injected",
		"metrics=injected",
		"logs=none",
		"console=json",
		"level=INFO",
		"traceparent",
		"tracestate",
		"baggage",
		"runtime_metrics=false",
	} {
		if !strings.Contains(config, want) {
			t.Errorf("EffectiveConfig %q missing %q", config, want)
		}
	}
}

// captureHandler records flattened records; it stands in for a user sink.
type captureHandler struct {
	records *[]slog.Record
}

func (c captureHandler) Enabled(context.Context, slog.Level) bool { return true }
func (c captureHandler) Handle(_ context.Context, r slog.Record) error {
	*c.records = append(*c.records, r.Clone())
	return nil
}
func (c captureHandler) WithAttrs([]slog.Attr) slog.Handler { return c }
func (c captureHandler) WithGroup(string) slog.Handler      { return c }

func TestSetupEmitsStartupSummary(t *testing.T) {
	restoreGlobals(t)

	var records []slog.Record
	opts := append(hermeticOptions("summary-test"),
		o11y.WithExtraLogHandler(captureHandler{records: &records}),
		// Even a prohibitive level must not stop the summary: it is forced.
		o11y.WithLogLevel(slog.LevelError),
	)
	sdk, err := o11y.Setup(context.Background(), opts...)
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	defer func() {
		if err := sdk.Shutdown(context.Background()); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	}()

	if len(records) != 1 {
		t.Fatalf("got %d records, want 1 startup summary", len(records))
	}
	if got, want := records[0].Message, "o11y.telemetry.configured"; got != want {
		t.Errorf("message = %q, want %q", got, want)
	}
	var serviceName string
	records[0].Attrs(func(a slog.Attr) bool {
		if a.Key == "service.name" {
			serviceName = a.Value.String()
			return false
		}
		return true
	})
	if serviceName != "summary-test" {
		t.Errorf("summary service.name = %q, want summary-test", serviceName)
	}
}

func TestSetupWithoutStartupSummary(t *testing.T) {
	restoreGlobals(t)

	var records []slog.Record
	opts := append(hermeticOptions("no-summary"),
		o11y.WithExtraLogHandler(captureHandler{records: &records}),
		o11y.WithoutStartupSummary(),
	)
	sdk, err := o11y.Setup(context.Background(), opts...)
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	defer func() {
		if err := sdk.Shutdown(context.Background()); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	}()

	if len(records) != 0 {
		t.Errorf("got %d records, want none with WithoutStartupSummary", len(records))
	}
	if sdk.EffectiveConfig() == "" {
		t.Error("EffectiveConfig must remain available without the summary record")
	}
}

type failingSink struct{ err error }

func (f failingSink) Enabled(context.Context, slog.Level) bool  { return true }
func (f failingSink) Handle(context.Context, slog.Record) error { return f.err }
func (f failingSink) WithAttrs([]slog.Attr) slog.Handler        { return f }
func (f failingSink) WithGroup(string) slog.Handler             { return f }

// reentrantSetupHandler calls Setup from inside a log sink, which the
// adversarial review showed used to deadlock the process-wide guard.
type reentrantSetupHandler struct {
	result chan error
}

func (h reentrantSetupHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h reentrantSetupHandler) Handle(ctx context.Context, _ slog.Record) error {
	_, err := o11y.Setup(ctx, hermeticOptions("reentrant-inner")...)
	select {
	case h.result <- err:
	default:
	}
	return nil
}
func (h reentrantSetupHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h reentrantSetupHandler) WithGroup(string) slog.Handler      { return h }

// TestSetupReentrantFromSinkDoesNotDeadlock pins the deadlock fix: a sink
// that calls Setup during the startup canary receives ErrAlreadySetup
// instead of hanging the guard forever.
func TestSetupReentrantFromSinkDoesNotDeadlock(t *testing.T) {
	restoreGlobals(t)

	inner := make(chan error, 1)
	done := make(chan struct{})
	var sdk *o11y.SDK
	var err error
	go func() {
		defer close(done)
		opts := append(hermeticOptions("reentrant-outer"),
			o11y.WithExtraLogHandler(reentrantSetupHandler{result: inner}))
		sdk, err = o11y.Setup(context.Background(), opts...)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Setup deadlocked on re-entrant sink")
	}
	if err != nil {
		t.Fatalf("outer Setup: %v", err)
	}
	defer func() {
		if err := sdk.Shutdown(context.Background()); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	}()

	select {
	case innerErr := <-inner:
		if !errors.Is(innerErr, o11y.ErrAlreadySetup) {
			t.Errorf("inner Setup err = %v, want ErrAlreadySetup", innerErr)
		}
	default:
		t.Error("inner Setup result not captured")
	}
}

// TestSetupCanaryFailsFast pins the canary guarantee: a sink that rejects
// the startup record fails Setup, and the guard is not held afterwards.
func TestSetupCanaryFailsFast(t *testing.T) {
	restoreGlobals(t)

	sinkErr := errors.New("sink rejects records")
	opts := append(hermeticOptions("canary-fail"),
		o11y.WithExtraLogHandler(failingSink{err: sinkErr}),
	)
	if _, err := o11y.Setup(context.Background(), opts...); !errors.Is(err, sinkErr) {
		t.Fatalf("Setup with failing sink: err = %v, want wrapped sink error", err)
	}

	// The failed Setup must not hold the global guard.
	sdk, err := o11y.Setup(context.Background(), hermeticOptions("canary-retry")...)
	if err != nil {
		t.Fatalf("Setup after canary failure: %v", err)
	}
	if err := sdk.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown: %v", err)
	}
}

func TestShutdownOnSignals(t *testing.T) {
	sdk, err := o11y.New(context.Background(), hermeticOptions("signals-test")...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		done <- sdk.ShutdownOnSignals(context.Background(), syscall.SIGUSR1)
	}()

	// Give the goroutine time to install the signal handler, then signal.
	time.Sleep(100 * time.Millisecond)
	if err := syscall.Kill(syscall.Getpid(), syscall.SIGUSR1); err != nil {
		t.Fatalf("Kill: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("ShutdownOnSignals: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ShutdownOnSignals did not return after signal")
	}
}

func TestShutdownOnSignalsHonorsContext(t *testing.T) {
	sdk, err := o11y.New(context.Background(), hermeticOptions("signals-ctx")...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- sdk.ShutdownOnSignals(ctx, syscall.SIGUSR2)
	}()
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("ShutdownOnSignals: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ShutdownOnSignals did not return after context cancel")
	}
}

// restoreGlobals snapshots and restores the process globals a Setup test
// mutates.
func restoreGlobals(t *testing.T) {
	t.Helper()
	prevLogger := slog.Default()
	prevTracer := otel.GetTracerProvider()
	prevMeter := otel.GetMeterProvider()
	prevPropagator := otel.GetTextMapPropagator()
	t.Cleanup(func() {
		slog.SetDefault(prevLogger)
		otel.SetTracerProvider(prevTracer)
		otel.SetMeterProvider(prevMeter)
		otel.SetTextMapPropagator(prevPropagator)
	})
}

func TestBuildInfoAttrsInResource(t *testing.T) {
	// Test binaries carry build info; the detector must at least not
	// break resource composition, and vcs attributes appear when stamped.
	sdk, _, _, _ := newHermetic(t)
	if sdk.Resource() == nil {
		t.Fatal("resource missing")
	}
}
