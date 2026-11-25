package o11yproc_test

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11yproc"
	"github.com/jamesainslie/libo11y/go/spec"
)

// noGlobalPropagator installs OpenTelemetry's no-op default as the global
// propagator for the test, the state of a process that never called Setup.
func noGlobalPropagator(t *testing.T) {
	t.Helper()
	prev := otel.GetTextMapPropagator()
	t.Cleanup(func() { otel.SetTextMapPropagator(prev) })
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator())
}

// newSDK builds an SDK with o11y.New, which installs no globals.
func newSDK(t *testing.T, opts ...o11y.Option) *o11y.SDK {
	t.Helper()
	opts = append([]o11y.Option{
		o11y.WithServiceName("o11yproc-test"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutOTELEnv(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
	}, opts...)
	sdk, err := o11y.New(context.Background(), opts...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
	return sdk
}

// sampledContext returns a context holding a sampled span from sdk and
// the baggage member tenant=acme.
func sampledContext(t *testing.T, sdk *o11y.SDK) (context.Context, trace.Span) {
	t.Helper()
	ctx, span := sdk.TracerProvider().Tracer("test").Start(context.Background(), "send")
	t.Cleanup(func() { span.End() })
	if !span.SpanContext().IsSampled() {
		t.Fatal("span is not sampled")
	}
	member, err := baggage.NewMember("tenant", "acme")
	if err != nil {
		t.Fatalf("NewMember: %v", err)
	}
	bag, err := baggage.New(member)
	if err != nil {
		t.Fatalf("baggage.New: %v", err)
	}
	return baggage.ContextWithBaggage(ctx, bag), span
}

func TestInjectExtractWithSDKUseItsPropagator(t *testing.T) {
	noGlobalPropagator(t)
	sdk := newSDK(t)
	ctx, span := sampledContext(t, sdk)

	frame := map[string]string{}
	o11yproc.Inject(ctx, frame, o11yproc.WithSDK(sdk))
	if frame["traceparent"] == "" {
		t.Fatalf("frame %v has no traceparent", frame)
	}
	if frame["baggage"] != "tenant=acme" {
		t.Errorf("frame baggage = %q, want tenant=acme", frame["baggage"])
	}

	out := o11yproc.Extract(context.Background(), frame, o11yproc.WithSDK(sdk))
	sc := trace.SpanContextFromContext(out)
	if sc.TraceID() != span.SpanContext().TraceID() || sc.SpanID() != span.SpanContext().SpanID() || !sc.IsRemote() {
		t.Errorf("extracted span context %v, want remote %v", sc, span.SpanContext())
	}
	if got := baggage.FromContext(out).Member("tenant").Value(); got != "acme" {
		t.Errorf("extracted baggage tenant = %q, want acme", got)
	}
}

// TestInjectWithSDKAppliesItsPropagatorConfig pins that the bound SDK's
// own propagator decides what travels: an SDK configured for trace context
// alone writes no baggage, even under a global propagator that would.
func TestInjectWithSDKAppliesItsPropagatorConfig(t *testing.T) {
	prev := otel.GetTextMapPropagator()
	t.Cleanup(func() { otel.SetTextMapPropagator(prev) })
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))

	sdk := newSDK(t, o11y.WithPropagators(propagation.TraceContext{}))
	ctx, _ := sampledContext(t, sdk)

	frame := map[string]string{}
	o11yproc.Inject(ctx, frame, o11yproc.WithSDK(sdk))
	if _, ok := frame["baggage"]; ok || frame["traceparent"] == "" {
		t.Errorf("frame = %v, want traceparent and no baggage", frame)
	}
	out := o11yproc.Extract(context.Background(), map[string]string{
		"traceparent": frame["traceparent"], "baggage": "tenant=acme",
	}, o11yproc.WithSDK(sdk))
	if got := baggage.FromContext(out).Len(); got != 0 {
		t.Errorf("extracted %d baggage members through a trace-context-only SDK, want 0", got)
	}
}

// TestInjectExtractWithoutSDKUseTheGlobalNoop pins the unchanged default:
// without WithSDK, or with a nil SDK, and before Setup, Inject writes
// nothing and Extract returns ctx unchanged.
func TestInjectExtractWithoutSDKUseTheGlobalNoop(t *testing.T) {
	noGlobalPropagator(t)
	sdk := newSDK(t)
	ctx, _ := sampledContext(t, sdk)

	for name, opts := range map[string][]o11yproc.Option{
		"no option": nil,
		"nil SDK":   {o11yproc.WithSDK(nil)},
	} {
		t.Run(name, func(t *testing.T) {
			frame := map[string]string{}
			o11yproc.Inject(ctx, frame, opts...)
			if len(frame) != 0 {
				t.Errorf("Inject wrote %v under the no-op global propagator, want nothing", frame)
			}
			base := context.Background()
			out := o11yproc.Extract(base, map[string]string{
				"traceparent": "00-11111111111111111111111111111111-1111111111111111-01",
				"baggage":     "tenant=acme",
			}, opts...)
			if out != base {
				t.Error("Extract changed ctx under the no-op global propagator")
			}
		})
	}
}
