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
// "traceparent" always, plus "tracestate" and "baggage" when present.
// [Inject] writes them into the map a frame encodes and [Extract] reads
// them back. Both use the global propagator, so after o11y.Setup the SDK's
// baggage egress filter applies. Before Setup the global propagator is
// OpenTelemetry's no-op default: Inject writes nothing and Extract returns
// ctx unchanged. With an SDK built by o11y.New, call
// sdk.Propagator().Inject(ctx, propagation.MapCarrier(frame)) and
// sdk.Propagator().Extract(ctx, propagation.MapCarrier(frame)) directly.
package o11yproc

import (
	"context"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
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

// Inject writes the trace context and baggage active in ctx into frame
// with the global propagator. frame must not be nil. Before o11y.Setup
// installs a propagator, Inject writes nothing.
func Inject(ctx context.Context, frame map[string]string) {
	otel.GetTextMapPropagator().Inject(ctx, propagation.MapCarrier(frame))
}

// Extract returns ctx with the trace context and baggage the global
// propagator reads from frame. Before o11y.Setup installs a propagator, it
// returns ctx unchanged.
func Extract(ctx context.Context, frame map[string]string) context.Context {
	return otel.GetTextMapPropagator().Extract(ctx, propagation.MapCarrier(frame))
}
