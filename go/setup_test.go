package o11y_test

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

func hermeticOptions(name string) []o11y.Option {
	return []o11y.Option{
		o11y.WithServiceName(name),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(tracetest.NewSpanRecorder()),
		o11y.WithMetricReader(sdkmetric.NewManualReader()),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
	}
}

// TestSetupLifecycle exercises the whole global lifecycle in one sequential
// test: install, guard against double setup, release on shutdown, reinstall.
// It restores the globals it changes.
func TestSetupLifecycle(t *testing.T) {
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

	sdk, err := o11y.Setup(context.Background(), hermeticOptions("setup-test")...)
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}

	if got := otel.GetTracerProvider(); got != sdk.TracerProvider() {
		t.Error("Setup did not install the global tracer provider")
	}
	if got := otel.GetMeterProvider(); got != sdk.MeterProvider() {
		t.Error("Setup did not install the global meter provider")
	}
	if got := otel.GetTextMapPropagator(); got == prevPropagator {
		t.Error("Setup did not install the global propagator")
	}
	fields := otel.GetTextMapPropagator().Fields()
	for _, want := range []string{"traceparent", "tracestate", "baggage"} {
		if !slices.Contains(fields, want) {
			t.Errorf("propagator fields %v missing %q (want W3C TraceContext + Baggage)", fields, want)
		}
	}

	if _, err := o11y.Setup(context.Background(), hermeticOptions("second")...); !errors.Is(err, o11y.ErrAlreadySetup) {
		t.Errorf("second Setup: err = %v, want ErrAlreadySetup", err)
	}

	if err := sdk.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	// Shutdown releases the guard: a new global SDK may be installed.
	sdk2, err := o11y.Setup(context.Background(), hermeticOptions("third")...)
	if err != nil {
		t.Fatalf("Setup after shutdown: %v", err)
	}
	if err := sdk2.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown second SDK: %v", err)
	}
}

// TestSetupInstallsGlobalLoggerProvider pins that Setup registers the SDK's
// LoggerProvider as the OpenTelemetry global, so third-party log bridges that
// use otel.GetLoggerProvider export through the configured pipeline.
func TestSetupInstallsGlobalLoggerProvider(t *testing.T) {
	prevLogger := slog.Default()
	prevTracer := otel.GetTracerProvider()
	prevMeter := otel.GetMeterProvider()
	prevLoggerProvider := otel.GetLoggerProvider()
	prevPropagator := otel.GetTextMapPropagator()
	t.Cleanup(func() {
		slog.SetDefault(prevLogger)
		otel.SetTracerProvider(prevTracer)
		otel.SetMeterProvider(prevMeter)
		otel.SetLoggerProvider(prevLoggerProvider)
		otel.SetTextMapPropagator(prevPropagator)
	})

	exp := &memLogExporter{}
	opts := append(hermeticOptions("setup-global-logs"),
		o11y.WithLogExporter(exp), o11y.WithoutStartupSummary())
	sdk, err := o11y.Setup(context.Background(), opts...)
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })

	var r log.Record
	r.SetBody(attribute.StringValue("via-global"))
	otel.GetLoggerProvider().Logger("third-party").Emit(context.Background(), r)
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatalf("ForceFlush: %v", err)
	}
	recs := exp.snapshot()
	if len(recs) != 1 || recs[0].Body().AsString() != "via-global" {
		t.Fatalf("record emitted through the global LoggerProvider not exported: %+v", recs)
	}
}

func TestSetupInstallsSlogDefault(t *testing.T) {
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

	sdk, err := o11y.Setup(context.Background(), hermeticOptions("slog-default")...)
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	defer func() {
		if err := sdk.Shutdown(context.Background()); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	}()

	if slog.Default() != sdk.Logger() {
		t.Error("Setup did not install the SDK logger as slog default")
	}
}

func TestSetupWithoutSlogDefault(t *testing.T) {
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

	opts := append(hermeticOptions("no-slog-default"), o11y.WithoutSlogDefault())
	sdk, err := o11y.Setup(context.Background(), opts...)
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	defer func() {
		if err := sdk.Shutdown(context.Background()); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	}()

	if slog.Default() == sdk.Logger() {
		t.Error("WithoutSlogDefault must prevent slog default installation")
	}
}

func TestSetupFailureDoesNotHoldGuard(t *testing.T) {
	// A Setup that fails (missing service name) must not block a later one.
	if _, err := o11y.Setup(context.Background(),
		o11y.WithSpanProcessor(tracetest.NewSpanRecorder()),
		o11y.WithMetricReader(sdkmetric.NewManualReader()),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
	); !errors.Is(err, o11y.ErrNoServiceName) {
		t.Fatalf("Setup without service name: err = %v, want ErrNoServiceName", err)
	}

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

	sdk, err := o11y.Setup(context.Background(), hermeticOptions("after-failure")...)
	if err != nil {
		t.Fatalf("Setup after failed Setup: %v", err)
	}
	if err := sdk.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown: %v", err)
	}
}
