package o11y_test

import (
	"context"
	"errors"
	"testing"
	"time"

	sdklog "go.opentelemetry.io/otel/sdk/log"
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
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("Shutdown took %v, want it bounded by the 1s deadline", elapsed)
	}
	if err == nil {
		t.Error("Shutdown returned nil despite the hung log export")
	}
	if n := len(spans.GetSpans()); n != 1 {
		t.Errorf("traces exported %d spans, want 1: a hung log exporter starved the trace flush", n)
	}
}

func TestConcurrentShutdownHonorsEachCallersDeadline(t *testing.T) {
	t.Parallel()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("shutdown2"), o11y.WithEnvironment("test"),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics(),
		o11y.WithLogExporter(hangingLogExporter{}))
	if err != nil {
		t.Fatal(err)
	}
	sdk.Logger().Info("stuck")
	first := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		first <- sdk.Shutdown(ctx)
	}()
	time.Sleep(50 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	err = sdk.Shutdown(ctx)
	if time.Since(start) > time.Second {
		t.Errorf("second caller waited %v despite a 100ms deadline", time.Since(start))
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("second caller error = %v, want DeadlineExceeded", err)
	}
	<-first
}
