package o11y

import (
	"io"
	"log/slog"
	"os"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/exemplar"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// ConsoleFormat selects the encoding of the console log stream.
type ConsoleFormat int

const (
	// ConsoleJSON emits one JSON object per log record. This is the default.
	ConsoleJSON ConsoleFormat = iota
	// ConsoleText emits logfmt-style key=value records, for local development.
	ConsoleText
)

// AttrReplacer rewrites or drops a log attribute before it is emitted.
// It is called for every event attribute on every sink (console and OTLP),
// with groups holding the names of the groups enclosing the attribute.
// Returning an attribute with an empty key drops it. Built-in record fields
// (time, level, message) are not passed to the replacer.
type AttrReplacer func(groups []string, attr slog.Attr) slog.Attr

// ErrorHandler receives errors from asynchronous telemetry operations, such
// as export failures. Handlers must be safe for concurrent use and must not
// block.
type ErrorHandler func(error)

// Option configures [New] and [Setup]. Precedence is strict: an explicit
// option overrides the corresponding standard OTEL_* environment variable,
// which overrides the library default.
type Option func(*settings)

type settings struct {
	serviceName    string
	serviceVersion string
	resourceAttrs  []attribute.KeyValue

	logLevel        slog.Leveler
	consoleWriter   io.Writer
	consoleFormat   ConsoleFormat
	consoleEnabled  bool
	logExport       bool
	attrReplacer    AttrReplacer
	extraLogHandler []slog.Handler

	sampler    sdktrace.Sampler
	propagator propagation.TextMapPropagator

	views          []sdkmetric.View
	exemplarFilter exemplar.Filter
	runtimeMetrics bool

	installSlogDefault bool
	errorHandler       ErrorHandler
	buildInfo          bool
	startupSummary     bool

	spanExporter  sdktrace.SpanExporter
	spanProcessor sdktrace.SpanProcessor
	metricReader  sdkmetric.Reader
}

func newSettings(opts []Option) *settings {
	s := &settings{
		consoleWriter:      os.Stdout,
		consoleFormat:      ConsoleJSON,
		consoleEnabled:     true,
		logExport:          true,
		runtimeMetrics:     true,
		installSlogDefault: true,
		buildInfo:          true,
		startupSummary:     true,
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// WithServiceName sets the service.name resource attribute. A service name
// is required: if neither this option nor the OTEL_SERVICE_NAME environment
// variable (nor service.name in OTEL_RESOURCE_ATTRIBUTES) provides one,
// [New] and [Setup] fail with [ErrNoServiceName].
func WithServiceName(name string) Option {
	return func(s *settings) { s.serviceName = name }
}

// WithServiceVersion sets the service.version resource attribute.
func WithServiceVersion(version string) Option {
	return func(s *settings) { s.serviceVersion = version }
}

// WithResourceAttributes adds attributes to the telemetry resource. They
// take precedence over detected and environment-provided attributes.
func WithResourceAttributes(attrs ...attribute.KeyValue) Option {
	return func(s *settings) { s.resourceAttrs = append(s.resourceAttrs, attrs...) }
}

// WithLogLevel sets the minimum level for all log sinks. The default is
// [slog.LevelInfo]. Pass a [slog.LevelVar] to change the level at runtime.
func WithLogLevel(level slog.Leveler) Option {
	return func(s *settings) { s.logLevel = level }
}

// WithConsoleWriter directs the console log stream to w. The default is
// [os.Stdout].
func WithConsoleWriter(w io.Writer) Option {
	return func(s *settings) { s.consoleWriter = w }
}

// WithConsoleFormat selects the console log encoding. The default is
// [ConsoleJSON].
func WithConsoleFormat(format ConsoleFormat) Option {
	return func(s *settings) { s.consoleFormat = format }
}

// WithoutConsoleLog disables the console log stream. Log records still flow
// to the OTLP pipeline and any extra handlers.
func WithoutConsoleLog() Option {
	return func(s *settings) { s.consoleEnabled = false }
}

// WithoutLogExport disables the OTLP log pipeline. Log records still flow to
// the console stream and any extra handlers. Traces and metrics are
// unaffected. Equivalent to OTEL_LOGS_EXPORTER=none, but scoped to this SDK.
func WithoutLogExport() Option {
	return func(s *settings) { s.logExport = false }
}

// WithAttrReplacer installs an attribute replacer applied uniformly to
// every log sink. Use it as an emit-time redaction catch-all; prefer the
// redact package for capture-time protection of your own types.
func WithAttrReplacer(replace AttrReplacer) Option {
	return func(s *settings) { s.attrReplacer = replace }
}

// WithExtraLogHandler adds an additional [slog.Handler] as a log sink
// alongside the console and OTLP sinks. Records it receives are already
// flattened: correlation attributes are added and group nesting is resolved.
//
// The handler runs synchronously on every emit, including the startup
// summary during [Setup]; it must not block, and it must not call [Setup]
// or [SDK.Shutdown] (a Setup call from inside a sink reports
// [ErrAlreadySetup]).
func WithExtraLogHandler(handler slog.Handler) Option {
	return func(s *settings) { s.extraLogHandler = append(s.extraLogHandler, handler) }
}

// WithTraceSampler sets the trace sampler. By default the SDK honors the
// standard OTEL_TRACES_SAMPLER environment variable and falls back to
// parentbased_always_on, preserving inbound sampling decisions.
func WithTraceSampler(sampler sdktrace.Sampler) Option {
	return func(s *settings) { s.sampler = sampler }
}

// WithPropagators replaces the default propagator (a composite of W3C Trace
// Context and W3C Baggage). Multiple propagators compose into one composite
// applied in order.
func WithPropagators(propagators ...propagation.TextMapPropagator) Option {
	return func(s *settings) {
		switch len(propagators) {
		case 0:
			s.propagator = nil // fall back to the default composite
		case 1:
			s.propagator = propagators[0]
		default:
			s.propagator = propagation.NewCompositeTextMapPropagator(propagators...)
		}
	}
}

// WithViews registers metric views on the meter provider.
func WithViews(views ...sdkmetric.View) Option {
	return func(s *settings) { s.views = append(s.views, views...) }
}

// WithHistogramBuckets overrides the explicit bucket boundaries of the named
// histogram instrument. The instrument name may use the wildcard forms
// supported by metric views (for example "http.server.*").
func WithHistogramBuckets(instrumentName string, boundaries []float64) Option {
	view := sdkmetric.NewView(
		sdkmetric.Instrument{Name: instrumentName},
		sdkmetric.Stream{Aggregation: sdkmetric.AggregationExplicitBucketHistogram{
			Boundaries: boundaries,
		}},
	)
	return func(s *settings) { s.views = append(s.views, view) }
}

// WithExemplarFilter sets the metric exemplar filter, overriding the
// OTEL_METRICS_EXEMPLAR_FILTER environment variable. The default,
// [exemplar.TraceBasedFilter], records an exemplar on a data point whenever
// a measurement happens inside a sampled span, stamping the span's trace
// and span IDs onto the metric stream. Exemplars are the metric leg of
// libo11y's three-way correlation: logs and spans share identity through
// the log pipeline, and exemplars let a metric data point be traced back
// to the exact request that produced it.
//
// Use [exemplar.AlwaysOnFilter] to record exemplars for unsampled traffic
// too, or [exemplar.AlwaysOffFilter] to disable exemplars.
func WithExemplarFilter(filter exemplar.Filter) Option {
	return func(s *settings) { s.exemplarFilter = filter }
}

// WithoutRuntimeMetrics disables the Go runtime metrics that are otherwise
// collected by default.
func WithoutRuntimeMetrics() Option {
	return func(s *settings) { s.runtimeMetrics = false }
}

// WithoutBuildInfo disables the build-info resource detector, which
// otherwise records the compiled binary's module version (as
// service.version when no explicit version is configured) and VCS stamp
// (vcs.revision, vcs.time, vcs.modified) from the Go build info.
func WithoutBuildInfo() Option {
	return func(s *settings) { s.buildInfo = false }
}

// WithoutStartupSummary prevents [Setup] from emitting its startup summary
// record. The summary doubles as an initialization canary: it is forced
// through the whole log pipeline, and a synchronously-rejecting sink
// (console writer, extra handlers) fails Setup rather than dropping
// records silently later. The OTLP sink batches asynchronously, so the
// canary does not verify collector connectivity. The resolved
// configuration remains available from [SDK.EffectiveConfig].
func WithoutStartupSummary() Option {
	return func(s *settings) { s.startupSummary = false }
}

// WithoutSlogDefault prevents [Setup] from installing the SDK logger as the
// process-wide slog default. It has no effect on [New], which never touches
// process globals.
func WithoutSlogDefault() Option {
	return func(s *settings) { s.installSlogDefault = false }
}

// WithErrorHandler routes asynchronous telemetry errors (such as export
// failures) to handle. The default handler writes rate-limited Warn records
// to a plain text stderr logger, deliberately outside the SDK's own log
// pipeline.
//
// A custom handler must not log through the SDK's pipeline (including the
// slog default installed by [Setup]): when the failing component is the log
// exporter itself, doing so recurses. Log to a separate destination, as the
// default does.
//
// The OpenTelemetry error handler is process-global, so only [Setup]
// installs it; under [New] this option has no effect.
func WithErrorHandler(handle ErrorHandler) Option {
	return func(s *settings) { s.errorHandler = handle }
}

// WithTraceExporter injects a span exporter, bypassing the exporter that
// would otherwise be built from OTEL_TRACES_EXPORTER and OTEL_EXPORTER_OTLP_*
// environment variables. Spans are still batched.
func WithTraceExporter(exporter sdktrace.SpanExporter) Option {
	return func(s *settings) { s.spanExporter = exporter }
}

// WithSpanProcessor injects a span processor in place of the default
// batching pipeline. Intended for tests and custom pipelines; the o11ytest
// package uses it to record spans synchronously.
func WithSpanProcessor(processor sdktrace.SpanProcessor) Option {
	return func(s *settings) { s.spanProcessor = processor }
}

// WithMetricReader injects a metric reader, bypassing the reader that would
// otherwise be built from OTEL_METRICS_EXPORTER and OTEL_EXPORTER_OTLP_*
// environment variables. The o11ytest package uses it with a manual reader.
func WithMetricReader(reader sdkmetric.Reader) Option {
	return func(s *settings) { s.metricReader = reader }
}
