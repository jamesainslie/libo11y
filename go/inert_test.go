package o11y_test

import (
	"context"
	"log/slog"
	"sync"
	"syscall"
	"testing"
	"time"

	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
)

// inertSDKs are the handles that must do nothing and never panic: the nil
// pointer New and Setup return with an error, and the zero value.
func inertSDKs() map[string]*o11y.SDK {
	return map[string]*o11y.SDK{"nil": nil, "zero": {}}
}

// noPanic runs fn and reports a panic as a test error.
func noPanic(t *testing.T, what string, fn func()) {
	t.Helper()
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("%s panicked: %v", what, r)
		}
	}()
	fn()
}

// sampledSpanContext returns a context holding a valid, sampled remote
// span context, so Capture has something it could capture.
func sampledSpanContext() context.Context {
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    trace.TraceID{1},
		SpanID:     trace.SpanID{2},
		TraceFlags: trace.FlagsSampled,
		Remote:     true,
	})
	return trace.ContextWithRemoteSpanContext(context.Background(), sc)
}

// TestInertSDKMethods calls every exported *SDK method on a nil pointer
// and on the zero value, and checks each documented inert result.
func TestInertSDKMethods(t *testing.T) {
	ctx := context.Background()
	for name, sdk := range inertSDKs() {
		t.Run(name, func(t *testing.T) {
			methods := []struct {
				name  string
				check func(t *testing.T)
			}{
				{"Shutdown", func(t *testing.T) {
					if err := sdk.Shutdown(ctx); err != nil {
						t.Errorf("Shutdown = %v, want nil", err)
					}
					if err := sdk.Shutdown(ctx); err != nil {
						t.Errorf("second Shutdown = %v, want nil", err)
					}
				}},
				{"ForceFlush", func(t *testing.T) {
					if err := sdk.ForceFlush(ctx); err != nil {
						t.Errorf("ForceFlush = %v, want nil", err)
					}
				}},
				{"Event", func(t *testing.T) { sdk.Event(ctx, "inert.event", slog.String("k", "v")) }},
				{"EffectiveConfig", func(t *testing.T) {
					if got := sdk.EffectiveConfig(); got != "" {
						t.Errorf("EffectiveConfig = %q, want empty", got)
					}
				}},
				{"TracerProvider", func(t *testing.T) {
					_, span := sdk.TracerProvider().Tracer("x").Start(ctx, "op")
					if span.SpanContext().IsValid() || span.IsRecording() {
						t.Error("TracerProvider started a real span, want a no-op")
					}
					span.End()
				}},
				{"MeterProvider", func(t *testing.T) {
					c, err := sdk.MeterProvider().Meter("x").Int64Counter("c")
					if err != nil {
						t.Fatalf("counter: %v", err)
					}
					c.Add(ctx, 1)
				}},
				{"LoggerProvider", func(t *testing.T) {
					if sdk.LoggerProvider().Logger("x") == nil {
						t.Error("LoggerProvider().Logger = nil")
					}
				}},
				{"Propagator", func(t *testing.T) {
					p := sdk.Propagator()
					if fields := p.Fields(); len(fields) != 0 {
						t.Errorf("Propagator fields = %v, want none", fields)
					}
					carrier := propagation.MapCarrier{}
					p.Inject(sampledSpanContext(), carrier)
					if len(carrier) != 0 {
						t.Errorf("Propagator injected %v, want nothing", carrier)
					}
					in := propagation.MapCarrier{"traceparent": "00-11111111111111111111111111111111-1111111111111111-01"}
					if trace.SpanContextFromContext(p.Extract(ctx, in)).IsValid() {
						t.Error("Propagator extracted a span context, want nothing")
					}
				}},
				{"Resource", func(t *testing.T) {
					res := sdk.Resource()
					if res == nil || res.Len() != 0 {
						t.Errorf("Resource = %v, want an empty resource", res)
					}
				}},
				{"Handler", func(t *testing.T) {
					h := sdk.Handler()
					if h == nil || !h.Enabled(ctx, slog.LevelInfo) {
						t.Errorf("Handler = %v, want a handler that shows the host its logs", h)
					}
					if h == slog.Default().Handler() {
						t.Error("Handler is slog.Default().Handler(), which writes through the log package")
					}
				}},
				{"Logger", func(t *testing.T) {
					l := sdk.Logger()
					if l == nil || l == slog.Default() || !l.Enabled(ctx, slog.LevelInfo) {
						t.Errorf("Logger = %v, want a logger over the inert stderr handler", l)
					}
					// What these write is checked in a child process by
					// TestInertHandlerIsSafeAsWrappedDefault.
				}},
				{"Capture", func(t *testing.T) {
					if got := sdk.Capture(sampledSpanContext()); !got.IsZero() {
						t.Errorf("Capture = %v, want the zero Carrier", got)
					}
				}},
				{"StartLinked", func(t *testing.T) {
					carrier := o11y.Capture(sampledSpanContext())
					_, span := sdk.StartLinked(ctx, carrier, "linked")
					if span.SpanContext().IsValid() || span.IsRecording() {
						t.Error("StartLinked started a real span, want a no-op")
					}
					span.End()
				}},
				{"ShutdownOnSignals", func(t *testing.T) {
					cctx, cancel := context.WithCancel(ctx)
					defer cancel()
					watched := &doneWatcher{Context: cctx, asked: make(chan struct{})}
					done := make(chan error, 1)
					go func() { done <- sdk.ShutdownOnSignals(watched, syscall.SIGUSR2) }()
					// Handshake: ShutdownOnSignals asks for ctx.Done only to
					// wait on it, so once it has, and before the cancel, it
					// cannot have returned.
					select {
					case <-watched.asked:
					case err := <-done:
						t.Fatalf("ShutdownOnSignals returned %v without waiting on the context", err)
					case <-time.After(5 * time.Second):
						t.Fatal("ShutdownOnSignals never waited on the context")
					}
					select {
					case err := <-done:
						t.Fatalf("ShutdownOnSignals returned %v before the context ended", err)
					default:
					}
					cancel()
					select {
					case err := <-done:
						if err != nil {
							t.Errorf("ShutdownOnSignals = %v, want nil", err)
						}
					case <-time.After(5 * time.Second):
						t.Fatal("ShutdownOnSignals did not return after the context ended")
					}
				}},
			}
			for _, m := range methods {
				t.Run(m.name, func(t *testing.T) {
					noPanic(t, m.name, func() { m.check(t) })
				})
			}
		})
	}
}

// TestRecordEmitEventWithInertSDK pins that flushing a wide event through
// a nil or zero SDK does nothing, and that a nil or zero Record is safe.
func TestRecordEmitEventWithInertSDK(t *testing.T) {
	ctx := context.Background()
	for name, sdk := range inertSDKs() {
		noPanic(t, "EmitEvent with "+name+" SDK", func() {
			_, rec := o11y.StartRecord(ctx)
			rec.Set(slog.String("k", "v"))
			rec.EmitEvent(ctx, sdk, "inert.event")
		})
	}
	records := map[string]*o11y.Record{"nil": nil, "zero": {}}
	for name, rec := range records {
		noPanic(t, name+" Record", func() {
			rec.Set(slog.String("k", "v"))
			rec.Add("n", 1)
			rec.Max("m", 2)
			rec.EmitEvent(ctx, nil, "inert.event")
		})
	}
}

// doneWatcher is a context that closes asked the first time its Done
// channel is requested, so a test can tell when a callee starts waiting.
type doneWatcher struct {
	context.Context
	once  sync.Once
	asked chan struct{}
}

func (w *doneWatcher) Done() <-chan struct{} {
	w.once.Do(func() { close(w.asked) })
	return w.Context.Done()
}
