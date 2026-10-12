// Package o11ygin instruments Gin applications with OpenTelemetry traces
// and metrics, bound to a libo11y SDK. It is the Gin counterpart of
// o11yhttp, a thin layer over otelgin. For requests not excluded by a
// filter, inbound W3C Trace Context and Baggage are extracted into the
// request context; otelgin skips filtered requests entirely, extraction
// included.
//
// It offers the o11yhttp options that otelgin supports natively:
// [WithSDK], [WithFilter], [WithIgnorePaths], and [WithSpanNameFormatter]
// (which receives the gin.Context rather than the operation and request).
// otelgin has no public-endpoint mechanism and no canonical log line, so
// o11yhttp's WithPublicEndpoint and WithCanonicalLine have no Gin
// counterpart.
//
// It lives in its own Go module so applications that do not use Gin never
// pull its dependency tree:
//
//	go get github.com/jamesainslie/libo11y/go/o11ygin
//
//	router := gin.New()
//	router.Use(o11ygin.Middleware("api", o11ygin.WithIgnorePaths("/healthz")), gin.Recovery())
//
// # Middleware order
//
// Register o11ygin.Middleware before gin.Recovery(). Recovery then runs
// inside the span, so the 500 it writes for a recovered panic is recorded
// on the span and its metrics. Registered after Recovery, the middleware
// is unwound by the panic: the span ends with no status and no
// http.response.status_code, and the request is missing from the HTTP
// metrics. gin.Default() already installs Recovery, so build the router
// with gin.New() and add Recovery after the middleware.
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
	sdk           *o11y.SDK
	filters       []otelgin.Filter
	nameFormatter func(*gin.Context) string
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
// A malformed pattern never matches, so its requests remain instrumented.
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

// WithSpanNameFormatter replaces the default span name formatter, which
// names spans from the method and the matched route pattern
// ("GET /users/:id"). The formatter runs before the route's handlers, with
// the route already matched, so c.FullPath is available; it is "" when no
// route matched. If the formatter returns "", otelgin names the span
// "HTTP <method> route not found". Keep the output low-cardinality: never
// include raw paths or identifiers.
func WithSpanNameFormatter(format func(c *gin.Context) string) Option {
	return func(c *config) { c.nameFormatter = format }
}

// Middleware returns Gin middleware that traces and measures every request,
// naming spans from the matched route pattern (for example
// "GET /users/:id") and adopting inbound W3C trace context and baggage.
// Register it before gin.Recovery (see the package documentation).
func Middleware(operation string, opts ...Option) gin.HandlerFunc {
	cfg := &config{}
	for _, opt := range opts {
		opt(cfg)
	}

	ginOpts := make([]otelgin.Option, 0, 5)
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
	if cfg.nameFormatter != nil {
		ginOpts = append(ginOpts, otelgin.WithSpanNameFormatter(cfg.nameFormatter))
	}
	return otelgin.Middleware(operation, ginOpts...)
}
