package o11y

import (
	"io"
	"log/slog"
	"os"
	"sort"
	"strings"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/exemplar"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
	"github.com/jamesainslie/libo11y/go/spec"
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
// which overrides the library default. [WithoutOTELEnv] removes the
// environment layer entirely.
type Option func(*settings)

type settings struct {
	serviceName       string
	serviceVersion    string
	serviceNamespace  string
	environment       spec.Environment
	extraEnvironments map[string]bool
	strictIdentity    bool
	versionFallback   bool
	resourceAttrs     []attribute.KeyValue

	logLevel        slog.Leveler
	consoleWriter   io.Writer
	consoleFormat   ConsoleFormat
	consoleEnabled  bool
	logExport       bool
	logExporter     sdklog.Exporter
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
	piiMode            PIIMode

	spanExporter  sdktrace.SpanExporter
	spanProcessor sdktrace.SpanProcessor
	metricReader  sdkmetric.Reader

	ignoreEnv bool
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
		strictIdentity:     true,
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

// WithServiceNamespace sets the service.namespace resource attribute, the
// grouping key that disambiguates services across teams or domains.
func WithServiceNamespace(namespace string) Option {
	return func(s *settings) { s.serviceNamespace = namespace }
}

// WithEnvironment sets the deployment.environment.name resource attribute.
// It is required at init (like the service name): [New] and [Setup] fail
// with [ErrNoEnvironment] when no environment resolves from this option or
// the standard OTEL_RESOURCE_ATTRIBUTES variable, and with
// [ErrInvalidEnvironment] when the value is outside the allowed set. The
// base set is production, staging, development, and test; extend it with
// [WithEnvironmentValues].
func WithEnvironment(env spec.Environment) Option {
	return func(s *settings) { s.environment = env }
}

// WithEnvironmentValues extends the set of accepted deployment environments
// beyond the spec's base values, for organizations that run additional
// environments (for example qa or perf).
func WithEnvironmentValues(values ...spec.Environment) Option {
	return func(s *settings) {
		if s.extraEnvironments == nil {
			s.extraEnvironments = map[string]bool{}
		}
		for _, v := range values {
			s.extraEnvironments[string(v)] = true
		}
	}
}

// WithoutStrictIdentity downgrades the tier-0 identity requirements (service
// name and deployment environment) from init errors to observed schema
// violations. Intended for migration and for tests; production services
// should let identity be enforced.
func WithoutStrictIdentity() Option {
	return func(s *settings) { s.strictIdentity = false }
}

// environmentAllowed reports whether env is in the base or extended set of
// accepted deployment environments.
func (s *settings) environmentAllowed(env string) bool {
	return spectables.EnvironmentValues[env] || s.extraEnvironments[env]
}

// allowedEnvironmentList renders the accepted environments for error
// messages.
func (s *settings) allowedEnvironmentList() string {
	values := make([]string, 0, len(spectables.EnvironmentValues)+len(s.extraEnvironments))
	for env := range spectables.EnvironmentValues {
		values = append(values, env)
	}
	for env := range s.extraEnvironments {
		values = append(values, env)
	}
	sort.Strings(values)
	return strings.Join(values, ", ")
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

// WithLogExporter injects a log record exporter, bypassing the exporter that
// would otherwise be built from OTEL_LOGS_EXPORTER and OTEL_EXPORTER_OTLP_*
// environment variables. Records are still batched. It enables log export,
// overriding an earlier [WithoutLogExport].
func WithLogExporter(exporter sdklog.Exporter) Option {
	return func(s *settings) {
		s.logExporter = exporter
		s.logExport = exporter != nil
	}
}

// WithAttrReplacer installs an attribute replacer applied uniformly to
// every log sink. Use it as an emit-time redaction catch-all; prefer the
// redact package for capture-time protection of your own types.
//
// The specification's sensitivity layer runs after this replacer and cannot
// be bypassed by it: attributes the spec classifies secret are always
// dropped, and PII attributes are handled per [WithPIIMode].
func WithAttrReplacer(replace AttrReplacer) Option {
	return func(s *settings) { s.attrReplacer = replace }
}

// WithPIIMode selects how attributes the specification classifies as PII are
// handled on the log pipeline. The default is [PIIHash].
func WithPIIMode(mode PIIMode) Option {
	return func(s *settings) { s.piiMode = mode }
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
