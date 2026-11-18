// Package o11yconnect instruments Connect RPC servers and clients
// (connectrpc.com/connect) with OpenTelemetry traces and metrics. It is a
// thin layer over connectrpc.com/otelconnect, the Connect project's own
// instrumentation, with libo11y's defaults: inbound trace context is
// adopted as the span parent (otelconnect links it by default), an SDK
// built with o11y.New can be bound with [WithSDK], and health checks can be
// excluded.
//
// Spans and metrics follow the OpenTelemetry RPC semantic conventions, as
// o11ygrpc's do: rpc.system.name is "connectrpc" for requests in the
// Connect protocol and "grpc" for the gRPC and gRPC-Web protocols,
// rpc.method is the procedure without its leading slash, and the duration
// histograms are rpc.server.call.duration and rpc.client.call.duration,
// with exemplars.
//
// It lives in its own Go module, so applications that do not use Connect
// never download it:
//
//	go get github.com/jamesainslie/libo11y/go/o11yconnect
//
//	interceptor, err := o11yconnect.ServerInterceptor(o11yconnect.WithIgnoreHealthChecks())
//	if err != nil {
//		return err
//	}
//	path, handler := greetv1connect.NewGreetServiceHandler(svc, connect.WithInterceptors(interceptor))
//
// It supports connect-go v1 (connectrpc.com/connect).
package o11yconnect

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	"connectrpc.com/otelconnect"

	o11y "github.com/jamesainslie/libo11y/go"
)

// healthProcedurePrefix is the procedure prefix of the gRPC health service,
// which connectrpc.com/grpchealth also serves.
const healthProcedurePrefix = "/grpc.health.v1.Health/"

// Option configures [ServerInterceptor] and [ClientInterceptor].
type Option func(*config)

type config struct {
	sdk            *o11y.SDK
	publicEndpoint bool
	ignoreHealth   bool
}

// WithSDK binds the instrumentation to sdk's tracer provider, meter
// provider, and propagator instead of the process globals. Use it with SDKs
// built by o11y.New; after o11y.Setup the globals already point at the SDK.
func WithSDK(sdk *o11y.SDK) Option {
	return func(c *config) { c.sdk = sdk }
}

// WithPublicEndpoint marks the server as internet-facing: inbound trace
// context is linked rather than adopted as parent, so untrusted callers
// cannot graft the server span onto internal traces. Each inbound RPC
// starts a new trace; when the caller sent valid trace context, the server
// span carries one link to the caller's span. Inbound baggage is still
// extracted into the RPC context. It affects inbound RPCs only.
//
// otelconnect extracts inbound context only when the request context holds
// no span yet. Behind HTTP instrumentation that has already started one,
// such as o11yhttp.NewHandler, the RPC span is a child of that span and the
// outer layer makes the trust decision: declare the endpoint public there
// too (o11yhttp.WithPublicEndpoint).
func WithPublicEndpoint() Option {
	return func(c *config) { c.publicEndpoint = true }
}

// WithIgnoreHealthChecks excludes grpc.health.v1 procedures from tracing
// and metrics on the interceptor it is passed to, server or client.
// otelconnect skips propagation for an excluded RPC as well: a client
// injects no trace context into it and a server extracts none from it
// (unless an outer layer, such as o11yhttp, already has).
func WithIgnoreHealthChecks() Option {
	return func(c *config) { c.ignoreHealth = true }
}

// ServerInterceptor returns an interceptor for handlers, to pass to
// connect.WithInterceptors when constructing them. It traces and measures
// inbound RPCs and adopts inbound trace context as the span parent (or
// links it, under [WithPublicEndpoint]) together with baggage. It fails
// only when otelconnect cannot create its instruments.
func ServerInterceptor(opts ...Option) (connect.Interceptor, error) {
	cfg := newConfig(opts)
	interceptor, err := otelconnect.NewInterceptor(cfg.common()...)
	if err != nil {
		return nil, fmt.Errorf("o11yconnect: %w", err)
	}
	return interceptor, nil
}

// ClientInterceptor returns an interceptor for clients, to pass to
// connect.WithInterceptors when constructing them. It traces and measures
// outbound RPCs and injects trace context and baggage with the configured
// propagator. It fails only when otelconnect cannot create its instruments.
// Like every otelconnect interceptor it also works on handlers, where it
// behaves as [ServerInterceptor] does, so passing the wrong one never
// changes whether inbound context is trusted.
func ClientInterceptor(opts ...Option) (connect.Interceptor, error) {
	interceptor, err := otelconnect.NewInterceptor(newConfig(opts).common()...)
	if err != nil {
		return nil, fmt.Errorf("o11yconnect: %w", err)
	}
	return interceptor, nil
}

func newConfig(opts []Option) *config {
	cfg := &config{}
	for _, opt := range opts {
		opt(cfg)
	}
	return cfg
}

// allow reports whether the RPC described by spec is instrumented.
func (c *config) allow(spec connect.Spec) bool {
	return !c.ignoreHealth || !strings.HasPrefix(spec.Procedure, healthProcedurePrefix)
}

// common returns the otelconnect options both sides share. Every
// otelconnect interceptor has a client and a server half, so the trust
// decision lives here: only [WithPublicEndpoint] turns adoption off.
func (c *config) common() []otelconnect.Option {
	var opts []otelconnect.Option
	if !c.publicEndpoint {
		opts = append(opts, otelconnect.WithTrustRemote())
	}
	if c.sdk != nil {
		opts = append(opts,
			otelconnect.WithTracerProvider(c.sdk.TracerProvider()),
			otelconnect.WithMeterProvider(c.sdk.MeterProvider()),
			otelconnect.WithPropagator(c.sdk.Propagator()),
		)
	}
	if c.ignoreHealth {
		opts = append(opts, otelconnect.WithFilter(func(_ context.Context, spec connect.Spec) bool {
			return c.allow(spec)
		}))
	}
	return opts
}
