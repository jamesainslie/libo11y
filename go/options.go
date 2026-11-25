package o11y

import (
	"bytes"
	"io"
	"log/slog"
	"os"
	"reflect"
	"slices"
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
// environment layer entirely. A nil Option is ignored.
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

	sampler sdktrace.Sampler
	// propagators are the propagators WithPropagators gave, in order; nil
	// when the option was not given.
	propagators []propagation.TextMapPropagator
	// baggageAllow decides which baggage keys leave the process on inject;
	// nil allows every key.
	baggageAllow func(string) bool

	views          []sdkmetric.View
	exemplarFilter exemplar.Filter
	runtimeMetrics bool

	installSlogDefault bool
	errorHandler       ErrorHandler
	buildInfo          bool
	startupSummary     bool
	piiMode            PIIMode
	piiHashKey         []byte

	spanExporter  sdktrace.SpanExporter
	spanProcessor sdktrace.SpanProcessor
	metricReader  sdkmetric.Reader

	ignoreEnv bool

	// disabled is set by newSDK when OTEL_SDK_DISABLED switches the SDK
	// off (see settings.sdkDisabled).
	disabled bool

	// sensitivity overrides the classification lookup when non-nil. It is
	// set only by test options; production SDKs use the generated table.
	sensitivity func(attribute.Key) spectables.Sensitivity

	// appRegistries are the registries WithAppRegistry named. newSDK loads
	// them before it builds the sensitivity policy.
	appRegistries []appRegistrySource
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
		if opt != nil {
			opt(s)
		}
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
// A nil level, including a typed nil pointer, selects the default.
func WithLogLevel(level slog.Leveler) Option {
	if isNil(level) {
		level = nil
	}
	return func(s *settings) { s.logLevel = level }
}

// WithConsoleWriter directs the console log stream to w. The default is
// [os.Stdout]. A nil w, including a typed nil pointer, selects the default.
func WithConsoleWriter(w io.Writer) Option {
	if isNil(w) {
		w = os.Stdout
	}
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
// overriding an earlier [WithoutLogExport]. A nil exporter instead disables
// log export, as [WithoutLogExport] does, and so does a typed nil pointer.
//
// OTEL_SDK_DISABLED=true overrides this option: nothing injected here
// receives telemetry while the SDK is disabled (see the package
// documentation). The SDK still owns what is injected and shuts it down
// exactly once, in [SDK.Shutdown] or when [New] fails.
func WithLogExporter(exporter sdklog.Exporter) Option {
	if isNil(exporter) {
		exporter = nil
	}
	return func(s *settings) {
		s.logExporter = exporter
		s.logExport = exporter != nil
	}
}

// WithAttrReplacer installs an attribute replacer applied uniformly to
// every log sink. Use it as an emit-time redaction catch-all; prefer the
// redact package for capture-time protection of your own types.
//
// The specification's sensitivity layer runs after this replacer, so
// renaming a key to a classified name cannot bypass it: attributes the spec
// classifies secret are always dropped, and PII attributes are handled per
// [WithPIIMode]. Classification is by key, so a replacer that renames a
// classified key to an unclassified one takes that attribute out of the
// layer's scope.
func WithAttrReplacer(replace AttrReplacer) Option {
	return func(s *settings) { s.attrReplacer = replace }
}

// WithPIIMode selects how attributes the specification classifies as PII are
// handled on logs (every slog sink, and every bridge on the SDK's
// LoggerProvider), on spans (span, event, and link attributes at export and
// in an injected span processor's OnEnd), and on the telemetry resource.
// Metric data point and exemplar filtered attributes drop PII under [PIIHash]
// too, since hashing would multiply series cardinality. The default is
// [PIIDrop]. [PIIHash] also needs [WithPIIHashKey].
//
// A PII or secret key that arrives through OTEL_RESOURCE_ATTRIBUTES and is
// dropped is exported with an empty value rather than omitted: the OTel
// providers merge the environment resource underneath the library's, and an
// empty value is the only way to win that merge.
func WithPIIMode(mode PIIMode) Option {
	return func(s *settings) { s.piiMode = mode }
}

// WithPIIHashKey sets the secret key for [PIIHash] tokens. Use at least 32
// random bytes from your secret store and keep it stable: rotating the key
// changes every token and breaks joins across the rotation. The key is
// copied.
func WithPIIHashKey(key []byte) Option {
	key = bytes.Clone(key)
	return func(s *settings) { s.piiHashKey = key }
}

// WithExtraLogHandler adds an additional [slog.Handler] as a log sink
// alongside the console and OTLP sinks. Records it receives are already
// flattened: correlation attributes are added and group nesting is resolved.
//
// The handler runs synchronously on every emit, including the startup
// summary during [Setup]; it must not block, and it must not call [Setup]
// or [SDK.Shutdown] (a Setup call from inside a sink reports
// [ErrAlreadySetup]).
//
// The handler must not route records back into the SDK's LoggerProvider or
// the global LoggerProvider (for example through an otelslog bridge): the
// SDK has already classified them, and that provider would classify them a
// second time.
//
// A nil handler, including a typed nil pointer, adds no sink.
func WithExtraLogHandler(handler slog.Handler) Option {
	return func(s *settings) {
		if isNil(handler) {
			return
		}
		s.extraLogHandler = append(s.extraLogHandler, handler)
	}
}

// WithTraceSampler sets the trace sampler. By default the SDK honors the
// standard OTEL_TRACES_SAMPLER environment variable and falls back to
// parentbased_always_on, preserving inbound sampling decisions. A nil
// sampler, including a typed nil pointer, selects that default.
func WithTraceSampler(sampler sdktrace.Sampler) Option {
	if isNil(sampler) {
		sampler = nil
	}
	return func(s *settings) { s.sampler = sampler }
}

// WithPropagators replaces the default propagator (a composite of W3C Trace
// Context and W3C Baggage), overriding the OTEL_PROPAGATORS environment
// variable. Without this option a non-empty OTEL_PROPAGATORS selects the
// propagators by name (tracecontext, baggage, b3, b3multi, jaeger, xray,
// ottrace, or none, resolved by OpenTelemetry contrib's autoprop package),
// and a name it does not know fails [New] and [Setup]. Multiple propagators
// compose into one composite applied in order.
//
// Nil entries, including typed nil pointers, are skipped. When none
// remain, the option has no effect: OTEL_PROPAGATORS applies, and without
// it the default composite.
func WithPropagators(propagators ...propagation.TextMapPropagator) Option {
	propagators = slices.DeleteFunc(slices.Clone(propagators), func(p propagation.TextMapPropagator) bool {
		return isNil(p)
	})
	return func(s *settings) {
		if len(propagators) == 0 {
			s.propagators = nil
			return
		}
		s.propagators = propagators
	}
}

// WithViews registers metric views on the meter provider. Each stream a view
// produces keeps its own attribute filter and exemplar reservoir, composed
// with the sensitivity policy, which removes secret and PII attributes from
// data points and exemplars (see [WithPIIMode]). Nil views are skipped.
func WithViews(views ...sdkmetric.View) Option {
	views = slices.DeleteFunc(slices.Clone(views), func(v sdkmetric.View) bool { return v == nil })
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
// too, or [exemplar.AlwaysOffFilter] to disable exemplars. A nil filter
// selects the default.
func WithExemplarFilter(filter exemplar.Filter) Option {
	return func(s *settings) { s.exemplarFilter = filter }
}

// WithoutRuntimeMetrics disables the Go runtime metrics that are otherwise
// collected by default. They also stay off while OTEL_SDK_DISABLED=true.
func WithoutRuntimeMetrics() Option {
	return func(s *settings) { s.runtimeMetrics = false }
}

// WithoutBuildInfo disables the build-info resource detector, which
// otherwise records the compiled binary's module version (as
// service.version when no explicit version is configured) and the VCS
// stamp from the Go build info, under the spec's names
// (vcs.ref.head.revision, o11y.build.time, o11y.build.modified).
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
// installs it. Under [New] the handler receives only the SDK's own
// warnings about its configuration, such as an OTEL_SDK_DISABLED value
// that is neither true nor false. A nil handle selects the default handler.
func WithErrorHandler(handle ErrorHandler) Option {
	return func(s *settings) { s.errorHandler = handle }
}

// WithTraceExporter injects a span exporter, bypassing the exporter that
// would otherwise be built from OTEL_TRACES_EXPORTER and OTEL_EXPORTER_OTLP_*
// environment variables. Spans are still batched, and the exporter receives
// them redacted by the sensitivity policy. It coexists with
// [WithSpanProcessor]: when both are given, both run. A nil exporter,
// including a typed nil pointer, means none is injected.
//
// OTEL_SDK_DISABLED=true overrides this option: nothing injected here
// receives telemetry while the SDK is disabled (see the package
// documentation). The SDK still owns what is injected and shuts it down
// exactly once, in [SDK.Shutdown] or when [New] fails.
//
// One value given to both [WithSpanProcessor] and [WithTraceExporter] is
// shut down twice, once in each role. Pass distinct values, or make the
// value's Shutdown idempotent.
func WithTraceExporter(exporter sdktrace.SpanExporter) Option {
	if isNil(exporter) {
		exporter = nil
	}
	return func(s *settings) { s.spanExporter = exporter }
}

// WithSpanProcessor sets the span processor. The SDK holds one: a later
// WithSpanProcessor replaces an earlier one. When no exporter is injected with
// [WithTraceExporter], the processor owns the export path and no exporter is
// built from the environment; when one is, both run. Spans delivered to the
// processor's OnEnd are redacted by the sensitivity policy; OnStart receives
// the live span before redaction, so a processor that reads attributes at
// start sees classified values. Intended for tests and custom pipelines; the
// o11ytest package uses it to record spans synchronously. A nil processor,
// including a typed nil pointer, means none is set.
//
// OTEL_SDK_DISABLED=true overrides this option: nothing injected here
// receives telemetry while the SDK is disabled (see the package
// documentation). The SDK still owns what is injected and shuts it down
// exactly once, in [SDK.Shutdown] or when [New] fails.
//
// One value given to both [WithSpanProcessor] and [WithTraceExporter] is
// shut down twice, once in each role. Pass distinct values, or make the
// value's Shutdown idempotent.
func WithSpanProcessor(processor sdktrace.SpanProcessor) Option {
	if isNil(processor) {
		processor = nil
	}
	return func(s *settings) { s.spanProcessor = processor }
}

// WithMetricReader injects a metric reader, bypassing the reader that would
// otherwise be built from OTEL_METRICS_EXPORTER and OTEL_EXPORTER_OTLP_*
// environment variables. The o11ytest package uses it with a manual reader.
// A nil reader, including a typed nil pointer, means none is injected.
//
// OTEL_SDK_DISABLED=true overrides this option: nothing injected here
// receives telemetry while the SDK is disabled (see the package
// documentation). The SDK still owns what is injected and shuts it down
// exactly once, in [SDK.Shutdown] or when [New] fails. An injected reader
// is shut down while [New] builds the SDK, because it is never registered
// and a periodic reader would otherwise run, reporting that it is not
// registered, on every interval; [SDK.MeterProvider] stays a real provider
// with no readers, so instruments can be created and nothing is collected.
func WithMetricReader(reader sdkmetric.Reader) Option {
	if isNil(reader) {
		reader = nil
	}
	return func(s *settings) { s.metricReader = reader }
}

// isNil reports whether v is nil or an interface holding a nil pointer or
// func, so an option can treat a typed nil collaborator as not set instead
// of storing a value whose methods panic.
func isNil(v any) bool {
	if v == nil {
		return true
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Pointer, reflect.Func:
		return rv.IsNil()
	default:
		return false
	}
}
