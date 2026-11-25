package o11y_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

// disabledProbe is an SDK with every signal injected in code, plus what it
// was given, so a test can check what each sink received.
type disabledProbe struct {
	sdk      *o11y.SDK
	recorder *tracetest.SpanRecorder
	spans    *tracetest.InMemoryExporter
	reader   *sdkmetric.ManualReader
	logs     *memLogExporter
	console  *bytes.Buffer
}

func newDisabledProbe(t *testing.T, extra ...o11y.Option) *disabledProbe {
	t.Helper()
	p := &disabledProbe{
		recorder: tracetest.NewSpanRecorder(),
		spans:    tracetest.NewInMemoryExporter(),
		reader:   sdkmetric.NewManualReader(),
		logs:     &memLogExporter{},
		console:  &bytes.Buffer{},
	}
	opts := append([]o11y.Option{
		o11y.WithServiceName("sdk-disabled"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(p.recorder),
		o11y.WithTraceExporter(keptSpanExporter{p.spans}),
		o11y.WithMetricReader(p.reader),
		o11y.WithLogExporter(p.logs),
		o11y.WithConsoleWriter(p.console),
	}, extra...)
	sdk, err := o11y.New(context.Background(), opts...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	p.sdk = sdk
	return p
}

// remoteParent returns a context holding a sampled remote span context, as
// inbound propagation would leave it.
func remoteParent() (context.Context, trace.SpanContext) {
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    trace.TraceID{0xa1},
		SpanID:     trace.SpanID{0xb2},
		TraceFlags: trace.FlagsSampled,
		Remote:     true,
	})
	return trace.ContextWithRemoteSpanContext(context.Background(), sc), sc
}

// exercise emits on every signal, then shuts the SDK down.
func (p *disabledProbe) exercise(t *testing.T) {
	t.Helper()
	ctx, _ := remoteParent()
	ctx, span := p.sdk.TracerProvider().Tracer("t").Start(ctx, "op")
	p.sdk.Logger().InfoContext(ctx, "still on the console")
	p.sdk.Event(ctx, "app.event")
	counter, err := p.sdk.MeterProvider().Meter("t").Int64Counter("c")
	if err != nil {
		t.Fatal(err)
	}
	counter.Add(ctx, 1)
	span.End()
	if err := p.sdk.ForceFlush(context.Background()); err != nil {
		t.Errorf("ForceFlush: %v", err)
	}
}

// metricsCollected reports whether the injected reader collects any metric.
func (p *disabledProbe) metricsCollected() bool {
	var rm metricdata.ResourceMetrics
	if err := p.reader.Collect(context.Background(), &rm); err != nil {
		return false // never registered with a meter provider
	}
	for _, sm := range rm.ScopeMetrics {
		if len(sm.Metrics) > 0 {
			return true
		}
	}
	return false
}

func TestSDKDisabledExportsNothing(t *testing.T) {
	for _, value := range []string{"true", "TRUE", "True"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("OTEL_SDK_DISABLED", value)
			p := newDisabledProbe(t)
			p.exercise(t)
			if n := len(p.recorder.Ended()); n != 0 {
				t.Errorf("injected span processor received %d spans, want none", n)
			}
			if n := len(p.spans.GetSpans()); n != 0 {
				t.Errorf("injected span exporter received %d spans, want none", n)
			}
			if p.metricsCollected() {
				t.Error("injected metric reader collected metrics, want none")
			}
			if n := len(p.logs.snapshot()); n != 0 {
				t.Errorf("injected log exporter received %d records, want none", n)
			}
			console := p.console.String()
			if !strings.Contains(console, "still on the console") {
				t.Errorf("console sink lost the record: %s", console)
			}
			_, parent := remoteParent()
			if !strings.Contains(console, parent.TraceID().String()) {
				t.Errorf("console record not correlated with the inbound trace: %s", console)
			}
			for _, signal := range []string{"traces", "metrics", "logs"} {
				if got, _ := configValue(p.sdk.EffectiveConfig(), "o11y.config."+signal); got != "none" {
					t.Errorf("o11y.config.%s = %q, want none", signal, got)
				}
			}
			if got, _ := configValue(p.sdk.EffectiveConfig(), "o11y.config.runtime_metrics"); got != "false" {
				t.Errorf("o11y.config.runtime_metrics = %q, want false", got)
			}
			if err := p.sdk.Shutdown(context.Background()); err != nil {
				t.Errorf("Shutdown: %v", err)
			}
		})
	}
}

// TestSDKDisabledKeepsPropagation pins that context still crosses process
// boundaries: inject writes the inbound trace, and a span started under it
// carries that trace.
func TestSDKDisabledKeepsPropagation(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "true")
	p := newDisabledProbe(t)
	t.Cleanup(func() { _ = p.sdk.Shutdown(context.Background()) })
	ctx, parent := remoteParent()
	ctx, span := p.sdk.TracerProvider().Tracer("t").Start(ctx, "op")
	defer span.End()
	if span.IsRecording() {
		t.Error("span is recording, want no span recorded")
	}
	carrier := propagation.MapCarrier{}
	p.sdk.Propagator().Inject(ctx, carrier)
	if !strings.Contains(carrier["traceparent"], parent.TraceID().String()) {
		t.Errorf("traceparent = %q, want the inbound trace %s", carrier["traceparent"], parent.TraceID())
	}
}

// TestSDKDisabledKeepsIdentityValidation pins that the switch does not
// change what New accepts.
func TestSDKDisabledKeepsIdentityValidation(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "true")
	t.Setenv("OTEL_SERVICE_NAME", "")
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "")
	_, err := o11y.New(context.Background(), o11y.WithEnvironment(spec.EnvironmentTest))
	if !errors.Is(err, o11y.ErrNoServiceName) {
		t.Errorf("New without a service name = %v, want ErrNoServiceName", err)
	}
}

// TestSDKDisabledOtherValues pins that only "true", in any case, disables
// the SDK, and that WithoutOTELEnv ignores the variable.
func TestSDKDisabledOtherValues(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value string
		opts  []o11y.Option
	}{
		{name: "false", value: "false"},
		{name: "one", value: "1"},
		{name: "yes", value: "yes"},
		{name: "padded", value: " true "},
		{name: "empty", value: ""},
		{name: "hermetic", value: "true", opts: []o11y.Option{o11y.WithoutOTELEnv()}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OTEL_SDK_DISABLED", tc.value)
			p := newDisabledProbe(t, tc.opts...)
			p.exercise(t)
			if n := len(p.recorder.Ended()); n != 1 {
				t.Errorf("span processor received %d spans, want 1", n)
			}
			if !p.metricsCollected() {
				t.Error("metric reader collected nothing, want the counter")
			}
			if err := p.sdk.Shutdown(context.Background()); err != nil {
				t.Errorf("Shutdown: %v", err)
			}
			if n := len(p.spans.GetSpans()); n != 1 {
				t.Errorf("span exporter received %d spans, want 1", n)
			}
		})
	}
}

// TestStartLinkedDetachesWithoutTelemetry pins that StartLinked starts
// detached work outside the request's trace even when no span is recorded:
// with the SDK disabled, and on an inert handle, the work must not log
// with the request's trace ID or send the request's traceparent on.
func TestStartLinkedDetachesWithoutTelemetry(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "true")
	disabled := newDisabledProbe(t)
	t.Cleanup(func() { _ = disabled.sdk.Shutdown(context.Background()) })
	request, parent := remoteParent()
	carrier := o11y.Capture(request)
	for name, sdk := range map[string]*o11y.SDK{"disabled": disabled.sdk, "inert": nil} {
		t.Run(name, func(t *testing.T) {
			ctx, span := sdk.StartLinked(request, carrier, "detached")
			defer span.End()
			if got := trace.SpanContextFromContext(ctx); got.TraceID() == parent.TraceID() {
				t.Errorf("detached context carries the request's trace %s", got.TraceID())
			}
			out := propagation.MapCarrier{}
			disabled.sdk.Propagator().Inject(ctx, out)
			if strings.Contains(out["traceparent"], parent.TraceID().String()) {
				t.Errorf("detached work would send the request's traceparent %q", out["traceparent"])
			}
		})
	}
}

// TestSDKDisabledWarnsOnUnrecognisedValue pins that a value that is
// neither true nor false is reported once through the SDK's error handler,
// as the specification asks for boolean variables, without failing New.
func TestSDKDisabledWarnsOnUnrecognisedValue(t *testing.T) {
	for _, tc := range []struct {
		value string
		warns int
	}{
		{"yes", 1},
		{"1", 1},
		{" true ", 1},
		{"true", 0},
		{"FALSE", 0},
		{"false", 0},
		{"", 0},
	} {
		t.Run(tc.value, func(t *testing.T) {
			t.Setenv("OTEL_SDK_DISABLED", tc.value)
			var warnings []error
			p := newDisabledProbe(t, o11y.WithErrorHandler(func(err error) { warnings = append(warnings, err) }))
			t.Cleanup(func() { _ = p.sdk.Shutdown(context.Background()) })
			if len(warnings) != tc.warns {
				t.Fatalf("error handler received %v, want %d warnings", warnings, tc.warns)
			}
			if tc.warns > 0 && !strings.Contains(warnings[0].Error(), fmt.Sprintf("%q", tc.value)) {
				t.Errorf("warning %q does not quote the value", warnings[0])
			}
		})
	}
}
