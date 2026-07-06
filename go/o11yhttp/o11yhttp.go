// Package o11yhttp instruments net/http servers and clients with
// OpenTelemetry traces and metrics using the stable HTTP semantic
// conventions, with libo11y's corrected defaults: route-aware span names
// ("GET /users/{id}" from Go 1.22+ ServeMux patterns) and simple filtering
// of noise endpoints.
//
// It is a thin layer over otelhttp; it reimplements nothing. By default the
// instrumentation uses the process globals installed by o11y.Setup; pass
// [WithSDK] to bind it to an SDK built with o11y.New instead.
package o11yhttp

import (
	"net/http"
	"path"
	"strings"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	o11y "github.com/jamesainslie/libo11y/go"
)

// Option configures the instrumentation constructors.
type Option func(*config)

type config struct {
	sdk           *o11y.SDK
	filters       []otelhttp.Filter
	publicServer  bool
	nameFormatter func(operation string, r *http.Request) string
}

// WithSDK binds the instrumentation to sdk's tracer provider, meter
// provider, and propagator instead of the process globals. Use it with SDKs
// built by o11y.New; after o11y.Setup the globals already point at the SDK.
func WithSDK(sdk *o11y.SDK) Option {
	return func(c *config) { c.sdk = sdk }
}

// WithFilter adds a predicate; requests for which it returns false are not
// traced or measured. All filters must pass for a request to be recorded.
func WithFilter(allow func(*http.Request) bool) Option {
	return func(c *config) { c.filters = append(c.filters, otelhttp.Filter(allow)) }
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

// WithPublicEndpoint marks the server as internet-facing: inbound trace
// context is linked rather than adopted as parent, so untrusted callers
// cannot graft onto internal traces.
func WithPublicEndpoint() Option {
	return func(c *config) { c.publicServer = true }
}

// WithSpanNameFormatter replaces the default span name formatter. The
// default prefers the matched ServeMux pattern ("GET /users/{id}"), then
// the operation name, then the request method.
func WithSpanNameFormatter(format func(operation string, r *http.Request) string) Option {
	return func(c *config) { c.nameFormatter = format }
}

// NewHandler instruments an http.Handler. The operation name seeds span
// names for requests that match no route pattern.
func NewHandler(handler http.Handler, operation string, opts ...Option) http.Handler {
	cfg := newConfig(opts)
	return otelhttp.NewHandler(handler, operation, cfg.serverOptions()...)
}

// NewMiddleware returns server instrumentation in middleware form, for
// routers that compose func(http.Handler) http.Handler chains.
func NewMiddleware(operation string, opts ...Option) func(http.Handler) http.Handler {
	cfg := newConfig(opts)
	return otelhttp.NewMiddleware(operation, cfg.serverOptions()...)
}

// NewTransport instruments an http.RoundTripper for outbound requests:
// spans, metrics, and W3C trace context injection. A nil base uses
// http.DefaultTransport.
func NewTransport(base http.RoundTripper, opts ...Option) http.RoundTripper {
	cfg := newConfig(opts)
	return otelhttp.NewTransport(base, cfg.transportOptions()...)
}

func newConfig(opts []Option) *config {
	cfg := &config{nameFormatter: defaultSpanName}
	for _, opt := range opts {
		opt(cfg)
	}
	return cfg
}

func (c *config) commonOptions() []otelhttp.Option {
	var opts []otelhttp.Option
	if c.sdk != nil {
		opts = append(opts,
			otelhttp.WithTracerProvider(c.sdk.TracerProvider()),
			otelhttp.WithMeterProvider(c.sdk.MeterProvider()),
			otelhttp.WithPropagators(c.sdk.Propagator()),
		)
	}
	opts = append(opts, otelhttp.WithSpanNameFormatter(c.nameFormatter))
	for _, filter := range c.filters {
		opts = append(opts, otelhttp.WithFilter(filter))
	}
	return opts
}

func (c *config) serverOptions() []otelhttp.Option {
	opts := c.commonOptions()
	if c.publicServer {
		opts = append(opts, otelhttp.WithPublicEndpointFn(func(*http.Request) bool { return true }))
	}
	return opts
}

func (c *config) transportOptions() []otelhttp.Option {
	return c.commonOptions()
}

// defaultSpanName names spans "METHOD pattern" when a ServeMux route
// pattern is available, keeping cardinality bounded while staying
// human-readable.
func defaultSpanName(operation string, r *http.Request) string {
	if r.Pattern != "" {
		if strings.Contains(r.Pattern, " ") {
			return r.Pattern // pattern registered with a method, e.g. "GET /users/{id}"
		}
		return r.Method + " " + r.Pattern
	}
	if operation != "" {
		return operation
	}
	return r.Method
}
