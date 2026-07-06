package o11y

import (
	"io"
	"log/slog"
	"os"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
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
	runtimeMetrics bool

	installSlogDefault bool
	errorHandler       ErrorHandler

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
func WithExtraLogHandler(handler slog.Handler) Option {
	return func(s *settings) { s.extraLogHandler = append(s.extraLogHandler, handler) }
}

// WithTracerSampler sets the trace sampler. By default the SDK honors the
// standard OTEL_TRACES_SAMPLER environment variable and falls back to
// parentbased_always_on, preserving inbound sampling decisions.
func WithTracerSampler(sampler sdktrace.Sampler) Option {
	return func(s *settings) { s.sampler = sampler }
}

// WithPropagators replaces the default propagator (a composite of W3C Trace
// Context and W3C Baggage).
func WithPropagators(propagator propagation.TextMapPropagator) Option {
	return func(s *settings) { s.propagator = propagator }
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

// WithoutRuntimeMetrics disables the Go runtime metrics that are otherwise
// collected by default.
func WithoutRuntimeMetrics() Option {
	return func(s *settings) { s.runtimeMetrics = false }
}

// WithoutSlogDefault prevents [Setup] from installing the SDK logger as the
// process-wide slog default. It has no effect on [New], which never touches
// process globals.
func WithoutSlogDefault() Option {
	return func(s *settings) { s.installSlogDefault = false }
}

// WithErrorHandler routes asynchronous telemetry errors (such as export
// failures) to handle. The default handler logs them to the console stream
// at Warn level, rate limited. Only [Setup] installs the handler globally.
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
