// Package o11ygin instruments Gin applications with OpenTelemetry traces
// and metrics, bound to a libo11y SDK. It is the Gin counterpart of
// o11yhttp, a thin layer over otelgin. For requests not excluded by a
// filter, inbound W3C Trace Context and Baggage are extracted into the
// request context; otelgin skips filtered requests entirely, extraction
// included.
//
// It offers the o11yhttp options that otelgin supports natively:
// [WithSDK], [WithFilter], [WithIgnorePaths], and [WithSpanNameFormatter]
// (which receives the gin.Context rather than the operation and request),
// plus [WithServerTiming], which it adds around otelgin.
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
	"context"
	"net/http"
	"path"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
)

// Option configures [Middleware].
type Option func(*config)

type config struct {
	sdk           *o11y.SDK
	filters       []func(*http.Request) bool
	nameFormatter func(*gin.Context) string
	serverTiming  bool
}

// WithSDK binds the instrumentation to sdk's tracer provider, meter
// provider, and propagator instead of the process globals. Use it with
// SDKs built by o11y.New; after o11y.Setup the globals already point at
// the SDK.
// A nil sdk is the same as not giving the option: the process globals
// are used.
func WithSDK(sdk *o11y.SDK) Option {
	return func(c *config) { c.sdk = sdk }
}

// WithFilter adds a predicate; requests for which it returns false are not
// traced or measured. All filters must pass for a request to be recorded.
// Each filter runs once per request, on the request as it arrived, before
// instrumentation modifies the request context. A nil allow adds no filter.
func WithFilter(allow func(*http.Request) bool) Option {
	return func(c *config) {
		if allow != nil {
			c.filters = append(c.filters, allow)
		}
	}
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
// include raw paths or identifiers. A nil format keeps the default.
func WithSpanNameFormatter(format func(c *gin.Context) string) Option {
	return func(c *config) { c.nameFormatter = format }
}

// WithServerTiming adds `Server-Timing: traceparent;desc="00-<trace-id>-<span-id>-<flags>"`
// to HTML responses, naming the server span, as o11yhttp's WithServerTiming
// does. A browser page instrumented with @libo11y/web makes the server span
// the parent of its app_load span, so the first page load joins the
// backend trace. An existing Server-Timing value the handler set is kept,
// and the entry is added after it.
//
// The entry is added when a handler commits the response headers through
// c.Writer (Write, WriteString, WriteHeaderNow or Flush, which c.HTML,
// c.Data and the other renderers call), and only if the response is HTML
// then: its Content-Type is text/html, or it has none and net/http will
// sniff text/html from the first write. A response with no body that Gin
// commits only after the middleware chain returns gets no entry. Unsampled
// spans get an entry with their flags; requests excluded by [WithFilter] or
// [WithIgnorePaths], or with no valid span context, get none.
func WithServerTiming() Option {
	return func(c *config) { c.serverTiming = true }
}

// Middleware returns Gin middleware that traces and measures every request,
// naming spans from the matched route pattern (for example
// "GET /users/:id") and adopting inbound W3C trace context and baggage.
// Register it before gin.Recovery (see the package documentation).
func Middleware(operation string, opts ...Option) gin.HandlerFunc {
	cfg := &config{}
	for _, opt := range opts {
		if opt != nil {
			opt(cfg)
		}
	}

	ginOpts := make([]otelgin.Option, 0, 4)
	var tracerProvider trace.TracerProvider
	if cfg.sdk != nil {
		tracerProvider = cfg.sdk.TracerProvider()
		ginOpts = append(ginOpts,
			otelgin.WithMeterProvider(cfg.sdk.MeterProvider()),
			otelgin.WithPropagators(cfg.sdk.Propagator()),
		)
	}
	if cfg.serverTiming {
		if tracerProvider == nil {
			tracerProvider = otel.GetTracerProvider() // what otelgin defaults to
		}
		tracerProvider = captureProvider{tracerProvider}
	}
	if tracerProvider != nil {
		ginOpts = append(ginOpts, otelgin.WithTracerProvider(tracerProvider))
	}
	if cfg.nameFormatter != nil {
		ginOpts = append(ginOpts, otelgin.WithSpanNameFormatter(cfg.nameFormatter))
	}
	// Filters are evaluated once below, before either timingWriter or otelgin
	// modifies the request context, so otelgin receives no filters of its own.
	instrumented := otelgin.Middleware(operation, ginOpts...)
	if !cfg.serverTiming && len(cfg.filters) == 0 {
		return instrumented
	}
	return func(c *gin.Context) {
		for _, allow := range cfg.filters {
			if !allow(c.Request) {
				c.Next()
				return
			}
		}
		if !cfg.serverTiming {
			instrumented(c)
			return
		}
		savedWriter, savedCtx := c.Writer, c.Request.Context()
		w := &timingWriter{ResponseWriter: savedWriter}
		c.Writer = w
		c.Request = c.Request.WithContext(context.WithValue(savedCtx, timingKey{}, w))
		defer func() {
			c.Writer = savedWriter
			c.Request = c.Request.WithContext(savedCtx)
		}()
		instrumented(c)
	}
}
