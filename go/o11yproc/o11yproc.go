// Package o11yproc carries trace context across process boundaries that
// have no request headers: into a child process through its environment,
// and through framed socket protocols as a string map.
//
// A parent passes its context to a child it starts:
//
//	cmd := exec.CommandContext(ctx, "worker")
//	cmd.Env = append(os.Environ(), o11yproc.Env(ctx)...)
//
// and the child adopts it once its telemetry is set up:
//
//	ctx := o11yproc.FromEnv(context.Background())
//	ctx, span := tracer.Start(ctx, "worker")
//
// The variables are TRACEPARENT and TRACESTATE, the names the OpenTelemetry
// specification gives environment carriers. Baggage does not travel through
// the environment: other tools on the host can read a process's
// environment, and baggage is not classified by the sensitivity policy.
//
// # Framed socket protocols
//
// A protocol that sends framed messages over a socket carries the trace
// context in each frame as string fields under the W3C names:
// "traceparent" when the context holds a valid span, and "tracestate" and
// "baggage" when the context has them. [Inject] writes them into the map a
// frame encodes and [Extract] reads them back.
//
// Pass [WithSDK] to bind both to an SDK built with o11y.New: they then use
// that SDK's propagator, so its baggage egress filter applies, and no
// process global is read:
//
//	o11yproc.Inject(ctx, frame, o11yproc.WithSDK(sdk))
//	ctx = o11yproc.Extract(ctx, frame, o11yproc.WithSDK(sdk))
//
// Without it they use the global propagator, so after o11y.Setup the SDK's
// baggage egress filter applies. Before Setup the global propagator is
// OpenTelemetry's no-op default: Inject writes nothing and Extract returns
// ctx unchanged.
package o11yproc

import (
	"context"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
)

// Environment variable names for the W3C trace context.
const (
	EnvTraceparent = "TRACEPARENT"
	EnvTracestate  = "TRACESTATE"
)

// Env returns the trace context active in ctx as two environment entries,
// "TRACEPARENT=..." and "TRACESTATE=...", ready to append to os.Environ()
// or to a non-nil exec.Cmd.Env. Appended to a nil exec.Cmd.Env they would
// be the child's only variables. TRACESTATE is empty when the context has no
// tracestate. Appended after os.Environ(), both replace values this process
// inherited, because exec uses the last value of a duplicated key, so an
// inherited tracestate never reaches the child with a new traceparent.
//
// Env returns nil when ctx holds no valid span context. A child started
// with append(os.Environ(), Env(ctx)...) then inherits whatever
// TRACEPARENT and TRACESTATE this process was started with. To start it
// with no parent, remove those two keys from the environment instead.
func Env(ctx context.Context) []string {
	if !trace.SpanContextFromContext(ctx).IsValid() {
		return nil
	}
	m := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, m)
	return []string{
		EnvTraceparent + "=" + m["traceparent"],
		EnvTracestate + "=" + m["tracestate"],
	}
}

// FromEnv returns ctx with the remote span context read from this process's
// TRACEPARENT and TRACESTATE variables, so spans the process starts become
// children of the parent's span. It returns ctx unchanged when TRACEPARENT
// is unset, empty, or invalid.
func FromEnv(ctx context.Context) context.Context {
	parent, ok := os.LookupEnv(EnvTraceparent)
	if !ok || parent == "" {
		return ctx
	}
	m := propagation.MapCarrier{"traceparent": parent}
	if state, ok := os.LookupEnv(EnvTracestate); ok && state != "" {
		m["tracestate"] = state
	}
	return propagation.TraceContext{}.Extract(ctx, m)
}

// Option configures [Inject] and [Extract].
type Option func(*config)

type config struct {
	sdk *o11y.SDK
}

// WithSDK binds [Inject] and [Extract] to sdk's propagator instead of the
// process-global one, so sdk's baggage egress filter applies. Use it with
// SDKs built by o11y.New; after o11y.Setup the global propagator already
// is the SDK's. A nil sdk keeps the global propagator.
func WithSDK(sdk *o11y.SDK) Option {
	return func(c *config) { c.sdk = sdk }
}

// propagator returns the propagator opts select: the bound SDK's, or the
// global one when no SDK is bound.
func propagator(opts []Option) propagation.TextMapPropagator {
	var c config
	for _, opt := range opts {
		if opt != nil {
			opt(&c)
		}
	}
	if c.sdk == nil {
		return otel.GetTextMapPropagator()
	}
	return c.sdk.Propagator()
}

// Inject writes the trace context and baggage active in ctx into frame
// with the propagator of the SDK bound by [WithSDK], or the global
// propagator without one. A nil frame has nowhere to write, so Inject does
// nothing. Without [WithSDK] and before o11y.Setup installs a propagator,
// Inject writes nothing.
func Inject(ctx context.Context, frame map[string]string, opts ...Option) {
	if frame == nil {
		return
	}
	propagator(opts).Inject(ctx, propagation.MapCarrier(frame))
}

// Extract returns ctx with the trace context and baggage read from frame
// by the propagator of the SDK bound by [WithSDK], or the global
// propagator without one. Without [WithSDK] and before o11y.Setup installs
// a propagator, it returns ctx unchanged.
func Extract(ctx context.Context, frame map[string]string, opts ...Option) context.Context {
	return propagator(opts).Extract(ctx, propagation.MapCarrier(frame))
}
