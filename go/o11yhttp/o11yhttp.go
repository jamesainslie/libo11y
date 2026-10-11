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
	"log/slog"
	"net/http"
	"path"
	"strings"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

// Option configures the instrumentation constructors.
type Option func(*config)

type config struct {
	sdk           *o11y.SDK
	filters       []otelhttp.Filter
	publicServer  bool
	canonicalLine bool
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

// WithPublicEndpoint marks the server as internet-facing: inbound trace
// context is linked rather than adopted as parent, so untrusted callers
// cannot graft onto internal traces.
func WithPublicEndpoint() Option {
	return func(c *config) { c.publicServer = true }
}

// WithCanonicalLine emits one wide event (a canonical log line) per request:
// the o11y.request.summary event carrying method, route, status, duration,
// and outcome, plus anything handlers accumulate on the request's
// o11y.Record (see o11y.RecordFromContext). The event fires even if the
// handler panics. Requests excluded by [WithFilter] or [WithIgnorePaths]
// emit no summary. Requires an SDK bound with [WithSDK].
func WithCanonicalLine() Option {
	return func(c *config) { c.canonicalLine = true }
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
	if cfg.canonicalLine {
		handler = cfg.wrapCanonical(handler)
	}
	handler = cfg.recordPanics(handler)
	return otelhttp.NewHandler(handler, operation, cfg.serverOptions()...)
}

// NewMiddleware returns server instrumentation in middleware form, for
// routers that compose func(http.Handler) http.Handler chains.
func NewMiddleware(operation string, opts ...Option) func(http.Handler) http.Handler {
	cfg := newConfig(opts)
	otel := otelhttp.NewMiddleware(operation, cfg.serverOptions()...)
	return func(next http.Handler) http.Handler {
		if cfg.canonicalLine {
			next = cfg.wrapCanonical(next)
		}
		return otel(cfg.recordPanics(next))
	}
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

// allowed reports whether every configured filter admits r, matching the
// decision otelhttp makes before it starts a span.
func (c *config) allowed(r *http.Request) bool {
	for _, allow := range c.filters {
		if !allow(r) {
			return false
		}
	}
	return true
}

// recordPanics marks the active server span as failed when the handler
// panics, then re-panics so net/http's own recovery still runs. otelhttp has
// no recover of its own, so without this a panicking request ends with an
// Unset span status. It sits inside otelhttp so the span is in context.
// The exception event itself is not recorded here: the SDK span's End,
// deferred by otelhttp, already records one for an in-flight panic, and a
// second would duplicate it. Filtered requests have no server span, so
// they pass straight through rather than marking whatever span an outer
// layer put in the context.
func (c *config) recordPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !c.allowed(r) {
			next.ServeHTTP(w, r)
			return
		}
		defer func() {
			if p := recover(); p != nil {
				trace.SpanFromContext(r.Context()).SetStatus(codes.Error, "panic")
				panic(p)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// wrapCanonical installs a per-request wide-event record and flushes it as
// the o11y.request.summary event when the request completes, including on
// panic. It runs inside the otelhttp span, so the event is correlated.
func (c *config) wrapCanonical(next http.Handler) http.Handler {
	if c.sdk == nil {
		return next // no SDK to emit through; canonical line is a no-op
	}
	return http.HandlerFunc(func(w http.ResponseWriter, outer *http.Request) {
		if !c.allowed(outer) {
			next.ServeHTTP(w, outer) // filtered: not traced, measured, or summarized
			return
		}
		start := time.Now()
		ctx, record := o11y.StartRecord(outer.Context())
		r := outer.WithContext(ctx)
		ww, st := trackResponse(w)

		panicked := false
		defer func() {
			// ServeMux records the matched pattern on the request it
			// receives, which is our clone. The enclosing otelhttp handler
			// names the span and labels its metrics from its own request,
			// so copy the pattern back before it looks.
			outer.Pattern = r.Pattern

			// A panic unwinds through here before the connection-level
			// recovery in http.Server; stamp the request as failed so the
			// canonical line does not misreport it as a success, then let
			// the panic keep propagating. A status already committed is
			// what the client received, so it stands; otherwise report 500.
			p := recover()
			status := st.final()
			if p != nil {
				panicked = true
				if !st.committed() {
					status = http.StatusInternalServerError
				}
			}

			outcome := spec.OutcomeSuccess
			if panicked || status >= 500 {
				outcome = spec.OutcomeFailure
			}
			method, exact := normalizeMethod(r.Method)
			attrs := []slog.Attr{slog.String("http.request.method", method)}
			if !exact {
				attrs = append(attrs, slog.String("http.request.method_original", r.Method))
			}
			attrs = append(attrs,
				slog.Int("http.response.status_code", status),
				slog.String(string(spec.OutcomeKey), string(outcome)),
				slog.Float64(string(spec.DurationKey), time.Since(start).Seconds()),
			)
			if r.Pattern != "" {
				attrs = append(attrs, slog.String("http.route", routeOnly(r.Pattern)))
			}
			record.EmitEvent(r.Context(), c.sdk, spec.EventRequestSummary, attrs...)

			if panicked {
				panic(p)
			}
		}()

		next.ServeHTTP(ww, r)
	})
}

// routeOnly strips a leading method from a ServeMux pattern
// ("GET /users/{id}" -> "/users/{id}").
func routeOnly(pattern string) string {
	if _, route, found := strings.Cut(pattern, " "); found {
		return route
	}
	return pattern
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
// human-readable. Methods outside the semantic-convention set are named
// "HTTP", as otelhttp does, so arbitrary request methods cannot mint new
// span names.
func defaultSpanName(operation string, r *http.Request) string {
	method, _ := normalizeMethod(r.Method)
	if method == methodOther {
		method = "HTTP" // semconv: unknown methods name the span "HTTP"
	}
	if r.Pattern != "" {
		if strings.Contains(r.Pattern, " ") {
			return r.Pattern // registered with a method, so the method is known
		}
		return method + " " + r.Pattern
	}
	if operation != "" {
		return operation
	}
	return method
}

// methodOther is the semantic-convention value for methods outside the
// known set.
const methodOther = "_OTHER"

// knownMethods mirrors the semantic-convention method set otelhttp uses
// (methodLookup in otelhttp v0.72.0 internal/semconv/util.go); keep it in
// sync with otelhttp's internal semconv method table.
var knownMethods = map[string]bool{
	http.MethodConnect: true, http.MethodDelete: true, http.MethodGet: true,
	http.MethodHead: true, http.MethodOptions: true, http.MethodPatch: true,
	http.MethodPost: true, http.MethodPut: true, http.MethodTrace: true,
}

// normalizeMethod maps a request method onto the bounded semantic-convention
// set the way otelhttp does for server spans: a known method passes through,
// a known method in another case is upper-cased, and anything else becomes
// "_OTHER". exact reports whether http.request.method_original can be
// omitted: the method is already in normalized form, or it is empty, for
// which otelhttp records no original either.
func normalizeMethod(method string) (normalized string, exact bool) {
	if method == "" {
		return methodOther, true // otelhttp records no original for an empty method
	}
	if knownMethods[method] {
		return method, true
	}
	if upper := strings.ToUpper(method); knownMethods[upper] {
		return upper, false
	}
	return methodOther, false
}
