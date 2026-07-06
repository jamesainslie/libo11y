// Package o11ygin instruments Gin applications with OpenTelemetry traces
// and metrics, bound to a libo11y SDK. It is the Gin counterpart of
// o11yhttp and mirrors its options.
//
// It lives in its own Go module so applications that do not use Gin never
// pull its dependency tree:
//
//	go get github.com/jamesainslie/libo11y/go/o11ygin
//
//	router := gin.New()
//	router.Use(o11ygin.Middleware("api", o11ygin.WithIgnorePaths("/healthz")))
package o11ygin

import (
	"net/http"
	"path"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"

	o11y "github.com/jamesainslie/libo11y/go"
)

// Option configures [Middleware].
type Option func(*config)

type config struct {
	sdk     *o11y.SDK
	filters []otelgin.Filter
}

// WithSDK binds the instrumentation to sdk's tracer provider, meter
// provider, and propagator instead of the process globals. Use it with
// SDKs built by o11y.New; after o11y.Setup the globals already point at
// the SDK.
func WithSDK(sdk *o11y.SDK) Option {
	return func(c *config) { c.sdk = sdk }
}

// WithFilter adds a predicate; requests for which it returns false are not
// traced or measured. All filters must pass for a request to be recorded.
func WithFilter(allow func(*http.Request) bool) Option {
	return func(c *config) { c.filters = append(c.filters, otelgin.Filter(allow)) }
}

// WithIgnorePaths excludes requests whose URL path matches any of the given
// patterns, in the syntax of [path.Match] (for example "/healthz" or
// "/debug/*"). Typical use is silencing health and readiness probes.
func WithIgnorePaths(patterns ...string) Option {
	return func(c *config) {
		c.filters = append(c.filters, func(r *http.Request) bool {
			for _, pattern := range patterns {
				if matched, err := path.Match(pattern, r.URL.Path); err == nil && matched {
					return false
				}
			}
			return true
		})
	}
}

// Middleware returns Gin middleware that traces and measures every request,
// naming spans from the matched route pattern (for example
// "GET /users/:id") and adopting inbound W3C trace context.
func Middleware(operation string, opts ...Option) gin.HandlerFunc {
	cfg := &config{}
	for _, opt := range opts {
		opt(cfg)
	}

	ginOpts := make([]otelgin.Option, 0, 4)
	if cfg.sdk != nil {
		ginOpts = append(ginOpts,
			otelgin.WithTracerProvider(cfg.sdk.TracerProvider()),
			otelgin.WithMeterProvider(cfg.sdk.MeterProvider()),
			otelgin.WithPropagators(cfg.sdk.Propagator()),
		)
	}
	if len(cfg.filters) > 0 {
		ginOpts = append(ginOpts, otelgin.WithFilter(cfg.filters...))
	}
	return otelgin.Middleware(operation, ginOpts...)
}
