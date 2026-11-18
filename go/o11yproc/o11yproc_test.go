package o11yproc_test

import (
	"context"
	"os"
	"slices"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/jamesainslie/libo11y/go/o11yproc"
	"github.com/jamesainslie/libo11y/go/o11ytest"
)

func TestEnvRoundTripsThroughTheEnvironment(t *testing.T) {
	rec := o11ytest.Start(t)
	tracer := rec.SDK.TracerProvider().Tracer("test")
	ctx, parent := tracer.Start(context.Background(), "parent")
	state, err := trace.ParseTraceState("vendor=abc")
	if err != nil {
		t.Fatalf("ParseTraceState: %v", err)
	}
	ctx = trace.ContextWithSpanContext(ctx, parent.SpanContext().WithTraceState(state))

	env := o11yproc.Env(ctx)
	if len(env) != 2 {
		t.Fatalf("Env = %q, want TRACEPARENT and TRACESTATE entries", env)
	}
	for _, entry := range env {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			t.Fatalf("entry %q is not KEY=VALUE", entry)
		}
		t.Setenv(key, value)
	}

	child := o11yproc.FromEnv(context.Background())
	sc := trace.SpanContextFromContext(child)
	if sc.TraceID() != parent.SpanContext().TraceID() || sc.SpanID() != parent.SpanContext().SpanID() {
		t.Errorf("FromEnv span context %v, want the parent's %v", sc, parent.SpanContext())
	}
	if !sc.IsRemote() {
		t.Error("adopted span context is not marked remote")
	}
	if got := sc.TraceState().Get("vendor"); got != "abc" {
		t.Errorf("tracestate vendor = %q, want abc", got)
	}

	_, span := tracer.Start(child, "child")
	span.End()
	parent.End()
	spans := rec.Spans()
	if len(spans) != 2 {
		t.Fatalf("recorded %d spans, want 2", len(spans))
	}
	i := slices.IndexFunc(spans, func(s sdktrace.ReadOnlySpan) bool { return s.Name() == "child" })
	if i < 0 {
		t.Fatal("no span named child was recorded")
	}
	if got := spans[i].Parent().SpanID(); got != parent.SpanContext().SpanID() {
		t.Errorf("child span parent = %v, want %v", got, parent.SpanContext().SpanID())
	}
}

func TestEnvOutsideASpanIsEmpty(t *testing.T) {
	if env := o11yproc.Env(context.Background()); env != nil {
		t.Errorf("Env outside any span = %q, want nil", env)
	}
}

func TestFromEnvIgnoresMissingAndInvalidValues(t *testing.T) {
	tests := []struct {
		name  string
		value string
		unset bool
	}{
		{name: "unset", unset: true},
		{name: "empty", value: ""},
		{name: "invalid", value: "00-not-a-traceparent"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Setenv first so the variable is restored after the test.
			t.Setenv(o11yproc.EnvTraceparent, tt.value)
			t.Setenv(o11yproc.EnvTracestate, "vendor=abc")
			if tt.unset {
				if err := os.Unsetenv(o11yproc.EnvTraceparent); err != nil {
					t.Fatalf("Unsetenv: %v", err)
				}
			}
			ctx := o11yproc.FromEnv(context.Background())
			if sc := trace.SpanContextFromContext(ctx); sc.IsValid() || sc.TraceState().Len() != 0 {
				t.Errorf("FromEnv adopted %v from TRACEPARENT=%q", sc, tt.value)
			}
		})
	}
}

func TestInjectExtractUseTheGlobalPropagator(t *testing.T) {
	prev := otel.GetTextMapPropagator()
	t.Cleanup(func() { otel.SetTextMapPropagator(prev) })
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))

	rec := o11ytest.Start(t)
	ctx, span := rec.SDK.TracerProvider().Tracer("test").Start(context.Background(), "send")
	defer span.End()
	member, err := baggage.NewMember("tenant", "acme")
	if err != nil {
		t.Fatalf("NewMember: %v", err)
	}
	bag, err := baggage.New(member)
	if err != nil {
		t.Fatalf("baggage.New: %v", err)
	}
	ctx = baggage.ContextWithBaggage(ctx, bag)

	frame := map[string]string{}
	o11yproc.Inject(ctx, frame)
	if frame["traceparent"] == "" {
		t.Fatalf("frame %v has no traceparent", frame)
	}
	out := o11yproc.Extract(context.Background(), frame)
	if got := trace.SpanContextFromContext(out).SpanID(); got != span.SpanContext().SpanID() {
		t.Errorf("extracted span %v, want %v", got, span.SpanContext().SpanID())
	}
	if got := baggage.FromContext(out).Member("tenant").Value(); got != "acme" {
		t.Errorf("extracted baggage tenant = %q, want acme", got)
	}

	// A different global propagator changes what travels: with trace
	// context alone, the frame carries no baggage.
	otel.SetTextMapPropagator(propagation.TraceContext{})
	frame = map[string]string{}
	o11yproc.Inject(ctx, frame)
	if _, ok := frame["baggage"]; ok || frame["traceparent"] == "" {
		t.Errorf("frame under a trace-context-only propagator = %v, want traceparent and no baggage", frame)
	}
	if got := baggage.FromContext(o11yproc.Extract(context.Background(), map[string]string{
		"traceparent": frame["traceparent"], "baggage": "tenant=acme",
	})).Len(); got != 0 {
		t.Errorf("extracted %d baggage members under a trace-context-only propagator, want 0", got)
	}
}

// TestEnvOverridesAnInheritedTracestate covers a process that was itself
// started with a trace context and now starts a child under a span from
// another trace that has no tracestate. The inherited TRACESTATE must not
// reach the child alongside the new TRACEPARENT.
func TestEnvOverridesAnInheritedTracestate(t *testing.T) {
	t.Setenv(o11yproc.EnvTraceparent, "00-11111111111111111111111111111111-1111111111111111-01")
	t.Setenv(o11yproc.EnvTracestate, "vendor=stale")

	rec := o11ytest.Start(t)
	ctx, span := rec.SDK.TracerProvider().Tracer("test").Start(context.Background(), "spawn")
	defer span.End()

	env := o11yproc.Env(ctx)
	keys := make([]string, 0, len(env))
	for _, entry := range env {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			t.Fatalf("entry %q is not KEY=VALUE", entry)
		}
		keys = append(keys, key)
		// exec keeps the last value of a duplicated key, as Setenv does here.
		t.Setenv(key, value)
	}
	if want := []string{o11yproc.EnvTraceparent, o11yproc.EnvTracestate}; !slices.Equal(keys, want) {
		t.Fatalf("Env keys = %q, want %q", keys, want)
	}

	sc := trace.SpanContextFromContext(o11yproc.FromEnv(context.Background()))
	if sc.TraceID() != span.SpanContext().TraceID() {
		t.Errorf("FromEnv trace %v, want %v", sc.TraceID(), span.SpanContext().TraceID())
	}
	if got := sc.TraceState().String(); got != "" {
		t.Errorf("child tracestate = %q, want none: the inherited value leaked", got)
	}
}
