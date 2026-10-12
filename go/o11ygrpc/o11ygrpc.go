// Package o11ygrpc instruments gRPC servers and clients with OpenTelemetry
// traces and metrics through the stats.Handler mechanism, the only
// instrumentation form supported by modern otelgrpc (the interceptor API
// was removed upstream).
//
// It is a thin layer over otelgrpc. By default the instrumentation uses the
// process globals installed by o11y.Setup; pass [WithSDK] to bind it to an
// SDK built with o11y.New instead. W3C Trace Context and Baggage travel in
// request metadata: the client handler injects them and the server handler
// extracts them.
//
//	server := grpc.NewServer(grpc.StatsHandler(o11ygrpc.ServerHandler()))
//	conn, err := grpc.NewClient(target, grpc.WithStatsHandler(o11ygrpc.ClientHandler()))
package o11ygrpc

import (
	"strings"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc/stats"

	o11y "github.com/jamesainslie/libo11y/go"
)

// Option configures the handler constructors.
type Option func(*config)

type config struct {
	sdk            *o11y.SDK
	publicEndpoint bool
	filters        []otelgrpc.Filter
}

// WithSDK binds the instrumentation to sdk's tracer provider, meter
// provider, and propagator instead of the process globals.
func WithSDK(sdk *o11y.SDK) Option {
	return func(c *config) { c.sdk = sdk }
}

// WithPublicEndpoint marks the server as internet-facing: inbound trace
// context is linked rather than adopted as parent, so untrusted callers
// cannot graft the server span onto internal traces. Each inbound RPC
// starts a new trace; when the caller sent valid trace context, the server
// span carries one link to the caller's span. It affects [ServerHandler]
// only.
//
// Two limits follow from otelgrpc. Inbound baggage is still adopted into
// the RPC context. An RPC excluded by a filter (see
// [WithIgnoreHealthChecks]) gets no server span, so the caller's span
// context stays current in its context and any span its handler starts
// joins the caller's trace.
func WithPublicEndpoint() Option {
	return func(c *config) { c.publicEndpoint = true }
}

// WithIgnoreHealthChecks excludes grpc.health.v1 probes from tracing and
// metrics on the handler it is passed to, server or client. Propagation is
// unaffected: on the server, inbound trace context and baggage are still
// extracted into the RPC's context, and on the client the caller's context
// is still injected.
func WithIgnoreHealthChecks() Option {
	return func(c *config) {
		c.filters = append(c.filters, func(info *stats.RPCTagInfo) bool {
			return !strings.HasPrefix(info.FullMethodName, "/grpc.health.v1.Health/")
		})
	}
}

// ServerHandler returns a stats.Handler for grpc.StatsHandler that traces
// and measures inbound RPCs, adopting inbound W3C trace context (or linking
// it, under [WithPublicEndpoint]) and baggage.
func ServerHandler(opts ...Option) stats.Handler {
	cfg := newConfig(opts)
	otelOpts := cfg.common()
	if cfg.publicEndpoint {
		otelOpts = append(otelOpts, otelgrpc.WithPublicEndpoint())
	}
	return otelgrpc.NewServerHandler(otelOpts...)
}

// ClientHandler returns a stats.Handler for grpc.WithStatsHandler that
// traces and measures outbound RPCs and injects W3C trace context and
// baggage.
func ClientHandler(opts ...Option) stats.Handler {
	return otelgrpc.NewClientHandler(newConfig(opts).common()...)
}

func newConfig(opts []Option) *config {
	cfg := &config{}
	for _, opt := range opts {
		opt(cfg)
	}
	return cfg
}

// common returns the otelgrpc options shared by both handlers.
func (c *config) common() []otelgrpc.Option {
	var opts []otelgrpc.Option
	if c.sdk != nil {
		opts = append(opts,
			otelgrpc.WithTracerProvider(c.sdk.TracerProvider()),
			otelgrpc.WithMeterProvider(c.sdk.MeterProvider()),
			otelgrpc.WithPropagators(c.sdk.Propagator()),
		)
	}
	if len(c.filters) > 0 {
		// otelgrpc keeps a single filter, so every configured filter is
		// combined into one that admits an RPC only when all of them do.
		filters := c.filters
		opts = append(opts, otelgrpc.WithFilter(func(info *stats.RPCTagInfo) bool {
			for _, allow := range filters {
				if !allow(info) {
					return false
				}
			}
			return true
		}))
	}
	return opts
}
