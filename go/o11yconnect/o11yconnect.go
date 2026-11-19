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
// A server can also emit one canonical log line per RPC ([WithCanonicalLine]).
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
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"
	"connectrpc.com/otelconnect"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
)

// healthProcedurePrefix is the procedure prefix of the gRPC health service,
// which connectrpc.com/grpchealth also serves.
const healthProcedurePrefix = "/grpc.health.v1.Health/"

// errCanonicalLineNeedsSDK is the error [ServerInterceptor] returns for
// [WithCanonicalLine] without [WithSDK], which would otherwise emit nothing.
var errCanonicalLineNeedsSDK = errors.New("o11yconnect: WithCanonicalLine requires WithSDK")

// Option configures [ServerInterceptor] and [ClientInterceptor].
type Option func(*config)

type config struct {
	sdk            *o11y.SDK
	publicEndpoint bool
	ignoreHealth   bool
	canonicalLine  bool
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
// links it, under [WithPublicEndpoint]) together with baggage. A handler
// that panics leaves its server span with status Error, and the panic keeps
// propagating to connect.WithRecover or net/http. It fails when
// [WithCanonicalLine] is given without [WithSDK], and when otelconnect
// cannot create its instruments.
func ServerInterceptor(opts ...Option) (connect.Interceptor, error) {
	cfg := newConfig(opts)
	var summarize *o11y.SDK
	if cfg.canonicalLine {
		if cfg.sdk == nil {
			return nil, errCanonicalLineNeedsSDK
		}
		summarize = cfg.sdk
	}
	return cfg.interceptor(summarize)
}

// ClientInterceptor returns an interceptor for clients, to pass to
// connect.WithInterceptors when constructing them. It traces and measures
// outbound RPCs and injects trace context and baggage with the configured
// propagator. It fails only when otelconnect cannot create its instruments.
// Like every otelconnect interceptor it also works on handlers, where it
// traces and measures inbound RPCs, decides trust in inbound context, and
// marks a panicking RPC's span as [ServerInterceptor] does, so passing the
// wrong one never changes whether inbound context is trusted. It never
// emits the canonical line ([WithCanonicalLine]), which is the server's.
func ClientInterceptor(opts ...Option) (connect.Interceptor, error) {
	return newConfig(opts).interceptor(nil) // the canonical line is the server's
}

// interceptor returns otelconnect's interceptor wrapped around a
// [handlerLayer], which runs inside the server span so that the span is in
// its context and the canonical line is correlated with it. A non-nil
// summarize turns the canonical line on.
func (c *config) interceptor(summarize *o11y.SDK) (connect.Interceptor, error) {
	interceptor, err := otelconnect.NewInterceptor(c.common()...)
	if err != nil {
		return nil, fmt.Errorf("o11yconnect: %w", err)
	}
	return chain{outer: interceptor, inner: handlerLayer{allow: c.allow, summarize: summarize}}, nil
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

// chain applies outer around inner, so inner runs inside outer's span.
type chain struct{ outer, inner connect.Interceptor }

func (c chain) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return c.outer.WrapUnary(c.inner.WrapUnary(next))
}

func (c chain) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return c.outer.WrapStreamingClient(c.inner.WrapStreamingClient(next))
}

func (c chain) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return c.outer.WrapStreamingHandler(c.inner.WrapStreamingHandler(next))
}

// handlerLayer is the handler-side work otelconnect does not do. It marks
// the server span as an error when the handler panics (otelconnect has no
// recover of its own, so the span would end with status Unset) and, when
// summarize is set, emits the canonical line. The exception event is left
// to the SDK span's End, which otelconnect defers and which records one for
// an in-flight panic. RPCs the filter excludes have no server span, so they
// pass straight through rather than marking a span an outer layer started.
// Client RPCs pass straight through too.
type handlerLayer struct {
	allow     func(connect.Spec) bool
	summarize *o11y.SDK
}

func (h handlerLayer) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (resp connect.AnyResponse, err error) {
		if req.Spec().IsClient || !h.allow(req.Spec()) {
			return next(ctx, req)
		}
		ctx, finish := h.begin(ctx)
		defer func() {
			finish(recover(), summary{
				spec: req.Spec(), protocol: req.Peer().Protocol, method: req.HTTPMethod(), unary: true, err: err,
			})
		}()
		return next(ctx, req)
	}
}

func (handlerLayer) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (h handlerLayer) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) (err error) {
		if !h.allow(conn.Spec()) {
			return next(ctx, conn)
		}
		ctx, finish := h.begin(ctx)
		defer func() {
			finish(recover(), summary{
				spec: conn.Spec(), protocol: conn.Peer().Protocol, method: http.MethodPost, err: err,
			})
		}()
		return next(ctx, conn)
	}
}

// begin starts handling one RPC. Under the canonical line it attaches a
// fresh o11y.Record to ctx. The caller defers finish with the recovered
// panic value and the RPC's result; finish marks the span, emits the
// canonical line, and re-panics.
func (h handlerLayer) begin(ctx context.Context) (context.Context, func(p any, s summary)) {
	var record *o11y.Record
	if h.summarize != nil {
		ctx, record = o11y.StartRecord(ctx)
	}
	start := time.Now()
	return ctx, func(p any, s summary) {
		if p != nil {
			trace.SpanFromContext(ctx).SetStatus(codes.Error, "panic")
		}
		if record != nil {
			s.start, s.panicked = start, p != nil
			emit(ctx, h.summarize, record, s)
		}
		if p != nil {
			panic(p)
		}
	}
}
