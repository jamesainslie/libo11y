// Package o11ygrpc instruments gRPC servers and clients with OpenTelemetry
// traces and metrics through the stats.Handler mechanism, the only
// instrumentation form supported by modern otelgrpc (the interceptor API
// was removed upstream).
//
// It is a thin layer over otelgrpc. By default the instrumentation uses the
// process globals installed by o11y.Setup; pass [WithSDK] to bind it to an
// SDK built with o11y.New instead.
//
//	server := grpc.NewServer(grpc.StatsHandler(o11ygrpc.ServerHandler()))
//	conn, err := grpc.NewClient(target, grpc.WithStatsHandler(o11ygrpc.ClientHandler()))
package o11ygrpc

import (
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc/stats"

	o11y "github.com/jamesainslie/libo11y/go"
)

// Option configures the handler constructors.
type Option func(*config)

type config struct {
	sdk *o11y.SDK
}

// WithSDK binds the instrumentation to sdk's tracer provider, meter
// provider, and propagator instead of the process globals.
func WithSDK(sdk *o11y.SDK) Option {
	return func(c *config) { c.sdk = sdk }
}

// ServerHandler returns a stats.Handler for grpc.StatsHandler that traces
// and measures inbound RPCs, adopting inbound W3C trace context.
func ServerHandler(opts ...Option) stats.Handler {
	return otelgrpc.NewServerHandler(translate(opts)...)
}

// ClientHandler returns a stats.Handler for grpc.WithStatsHandler that
// traces and measures outbound RPCs and injects W3C trace context.
func ClientHandler(opts ...Option) stats.Handler {
	return otelgrpc.NewClientHandler(translate(opts)...)
}

func translate(opts []Option) []otelgrpc.Option {
	cfg := &config{}
	for _, opt := range opts {
		opt(cfg)
	}
	if cfg.sdk == nil {
		return nil
	}
	return []otelgrpc.Option{
		otelgrpc.WithTracerProvider(cfg.sdk.TracerProvider()),
		otelgrpc.WithMeterProvider(cfg.sdk.MeterProvider()),
		otelgrpc.WithPropagators(cfg.sdk.Propagator()),
	}
}
