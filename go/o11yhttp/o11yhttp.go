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
	semconv "go.opentelemetry.io/otel/semconv/v1.41.0"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/internal/servertiming"
	"github.com/jamesainslie/libo11y/go/spec"
)

// Option configures the instrumentation constructors.
type Option func(*config)

type config struct {
	sdk           *o11y.SDK
	filters       []otelhttp.Filter
	publicServer  bool
	canonicalLine bool
	serverTiming  bool
	nameFormatter func(operation string, r *http.Request) string
}

// WithSDK binds the instrumentation to sdk's tracer provider, meter
// provider, and propagator instead of the process globals. Use it with SDKs
// built by o11y.New; after o11y.Setup the globals already point at the SDK.
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
			c.filters = append(c.filters, otelhttp.Filter(allow))
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
// emit no summary. Requires an SDK bound with [WithSDK]; without one, it is
// a no-op.
func WithCanonicalLine() Option {
	return func(c *config) { c.canonicalLine = true }
}

// WithServerTiming adds `Server-Timing: traceparent;desc="00-<trace-id>-<span-id>-<flags>"`
// to HTML responses, naming the server span. A browser page instrumented
// with @libo11y/web reads it from the navigation timing entry and makes the
// server span the parent of its app_load span, so the first page load
// joins the backend trace. An existing Server-Timing value the handler set
// is kept, and the entry is added after it.
//
// The entry is added when the handler commits the response headers (the
// first WriteHeader with a final status, Write, Flush, or ReadFrom that
// copies bytes, direct or through [http.ResponseController]), and only if
// the response is HTML then: its Content-Type is text/html, or it has none
// and net/http will sniff text/html from the first bytes written. Set
// Content-Type before calling WriteHeader. A handler that never writes or
// calls WriteHeader gets no entry, since net/http commits its headers only
// after the handler returns. Unsampled spans get an entry with their
// flags; requests excluded by [WithFilter] or [WithIgnorePaths], or with no
// valid span context, get none.
func WithServerTiming() Option {
	return func(c *config) { c.serverTiming = true }
}

// WithSpanNameFormatter replaces the default span name formatter. The
// default names spans from the matched ServeMux pattern ("GET /users/{id}"),
// or the normalized request method ("GET", or "HTTP" for unknown methods)
// when no route matched. A nil format keeps the default.
func WithSpanNameFormatter(format func(operation string, r *http.Request) string) Option {
	return func(c *config) {
		if format != nil {
			c.nameFormatter = format
		}
	}
}

// NewHandler instruments an http.Handler. The operation name is passed to a
// custom [WithSpanNameFormatter]; the default formatter ignores it and names
// spans from the matched route or request method. A panic in the handler,
// including http.ErrAbortHandler, marks the server span Error and keeps
// propagating. handler must not be nil: a nil handler is a programming
// error, and a request through it panics.
func NewHandler(handler http.Handler, operation string, opts ...Option) http.Handler {
	return NewMiddleware(operation, opts...)(handler)
}

// NewMiddleware returns server instrumentation in middleware form, for
// routers that compose func(http.Handler) http.Handler chains. As with
// [NewHandler], a panic, including http.ErrAbortHandler, marks the server
// span Error and keeps propagating.
func NewMiddleware(operation string, opts ...Option) func(http.Handler) http.Handler {
	cfg := newConfig(opts)
	otel := otelhttp.NewMiddleware(operation, cfg.serverOptions()...)
	return func(next http.Handler) http.Handler {
		instrumented := next
		if cfg.canonicalLine {
			instrumented = cfg.wrapCanonical(instrumented)
		}
		if cfg.serverTiming {
			instrumented = cfg.wrapServerTiming(instrumented)
		}
		instrumented = otel(cfg.finishSpan(instrumented))
		if len(cfg.filters) == 0 {
			return instrumented
		}
		// The filters are asked here, once, on the request as it arrived,
		// and a request they exclude goes straight to next: it is not
		// traced, measured, summarized, or given a Server-Timing entry.
		// Asking again inside the server span could get another answer,
		// because a filter may read the request context and the span
		// changes it.
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !cfg.allowed(r) {
				next.ServeHTTP(w, r)
				return
			}
			instrumented.ServeHTTP(w, r)
		})
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
		if opt != nil {
			opt(cfg)
		}
	}
	return cfg
}

// allowed reports whether every configured filter admits r. A server asks
// once per request (see NewMiddleware).
func (c *config) allowed(r *http.Request) bool {
	for _, allow := range c.filters {
		if !allow(r) {
			return false
		}
	}
	return true
}

// restoreRequest copies back to outer what a handler sets on clone, a
// copy of outer made with WithContext. ServeMux records the matched
// pattern on the request it receives, and whoever wraps this handler names
// spans and labels metrics from its own request. ParseMultipartForm records
// the form on the request it is called on, and net/http removes an
// upload's temporary files through the request it created. Call it
// deferred, so it also runs while a panic unwinds.
func restoreRequest(outer, clone *http.Request) {
	if clone.Pattern != "" {
		outer.Pattern = clone.Pattern
	}
	if clone.MultipartForm != nil {
		outer.MultipartForm = clone.MultipartForm
	}
}

// finishSpan completes the server span once the handler returns or panics.
// It sits inside otelhttp so the span is in context.
//
// It sets http.route from the pattern ServeMux matched. otelhttp names the
// span and labels the duration metric from that pattern but reads it for
// the span's attributes before the mux has run.
//
// It marks the span as failed when the handler panics, then re-panics so
// net/http's own recovery still runs. otelhttp has no recover of its own,
// so without this a panicking request ends with an Unset span status. The
// exception event itself is not recorded here: the SDK span's End,
// deferred by otelhttp, already records one for an in-flight panic, and a
// second would duplicate it.
func (c *config) finishSpan(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			span := trace.SpanFromContext(r.Context())
			if route := routeOf(r.Pattern); route != "" {
				span.SetAttributes(semconv.HTTPRoute(route))
			}
			if p := recover(); p != nil {
				span.SetStatus(codes.Error, "panic")
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
		start := time.Now()
		ctx, record := o11y.StartRecord(outer.Context())
		r := outer.WithContext(ctx)
		ww, st := trackResponse(w)

		panicked := false
		defer func() {
			restoreRequest(outer, r)

			// A panic unwinds through here before the connection-level
			// recovery in http.Server; stamp the request as failed so the
			// canonical line does not misreport it as a success, then let
			// the panic keep propagating. A status the handler already
			// committed (or a hijack) stands, because net/http can no longer
			// replace it; otherwise report 500.
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
			if route := routeOf(r.Pattern); route != "" {
				attrs = append(attrs, slog.String("http.route", route))
			}
			record.EmitEvent(r.Context(), c.sdk, spec.EventRequestSummary, attrs...)

			if panicked {
				panic(p)
			}
		}()

		next.ServeHTTP(ww, r)
	})
}

// wrapServerTiming adds the server span's Server-Timing entry to HTML
// responses (see [WithServerTiming]). It runs inside the otelhttp span, so
// the span is in the request context. A request the filters exclude never
// reaches it.
func (c *config) wrapServerTiming(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entry, ok := servertiming.Entry(trace.SpanContextFromContext(r.Context()))
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(timingResponse(w, entry), r)
	})
}

// routeOf returns the http.route of a ServeMux pattern: the path template,
// without the method and host a pattern may start with
// ("GET example.com/users/{id}" -> "/users/{id}"). It is "" when no pattern
// matched. otelhttp derives the route on the duration metric the same way.
func routeOf(pattern string) string {
	if i := strings.IndexByte(pattern, '/'); i >= 0 {
		return pattern[i:]
	}
	return ""
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
	return append(opts, otelhttp.WithSpanNameFormatter(c.nameFormatter))
}

// serverOptions gives otelhttp no filters: NewMiddleware asks them itself,
// once per request, before otelhttp runs.
func (c *config) serverOptions() []otelhttp.Option {
	opts := c.commonOptions()
	if c.publicServer {
		opts = append(opts, otelhttp.WithPublicEndpointFn(func(*http.Request) bool { return true }))
	}
	return opts
}

// transportOptions gives otelhttp the filters themselves: the transport has
// no wrappers of its own, so otelhttp is the only one to ask them.
func (c *config) transportOptions() []otelhttp.Option {
	opts := c.commonOptions()
	for _, filter := range c.filters {
		opts = append(opts, otelhttp.WithFilter(filter))
	}
	return opts
}

// defaultSpanName names spans "METHOD pattern" when a ServeMux route
// pattern is available, and the normalized method alone otherwise, keeping
// cardinality bounded while staying human-readable. Methods outside the
// semantic-convention set are named "HTTP", as otelhttp does, so arbitrary
// request methods cannot mint new span names.
func defaultSpanName(_ string, r *http.Request) string {
	method, _ := normalizeMethod(r.Method)
	if method == methodOther {
		method = "HTTP" // semconv: unknown methods name the span "HTTP"
	}
	if r.Pattern != "" {
		if strings.Contains(r.Pattern, " ") {
			// Registered with a method. ServeMux accepts any method token
			// there, so it may be nonstandard, but cardinality stays bounded
			// by the registered patterns.
			return r.Pattern
		}
		return method + " " + r.Pattern
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
