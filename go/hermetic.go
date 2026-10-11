package o11y

import (
	"os"
	"time"

	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// WithoutOTELEnv makes the SDK ignore the OTEL_* environment variables: its
// configuration comes only from options and library defaults. The resource
// omits OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME; sampler, span limits,
// log record limits, batching, cardinality limit, and exemplar filter use the
// SDK defaults; and a signal with no injected exporter, processor, or reader
// is disabled instead of being built from the environment (traces are still
// sampled and visible to in-process processors, metrics have no reader, and
// logs are not exported). Use it for hermetic tests and for hosting several
// isolated SDKs in one process. It is the one deliberate exception to
// option-over-environment-over-default precedence, and it is opt-in.
//
// Exporters, processors, and readers the caller injects are constructed by
// the caller and read whatever environment they read; WithoutOTELEnv governs
// only what the library builds.
//
// Maintenance: the environment reads below were audited against otel/sdk,
// otel/sdk/metric, and otel/sdk/log v1.47.0 and contrib v0.72.0. Re-audit on
// every OpenTelemetry upgrade.
//
// Pinned by an explicit option under WithoutOTELEnv:
//   - OTEL_RESOURCE_ATTRIBUTES, OTEL_SERVICE_NAME (sdk/resource fromEnv):
//     resource.WithFromEnv is omitted from the resource detectors.
//   - OTEL_TRACES_SAMPLER, OTEL_TRACES_SAMPLER_ARG (sdk/trace samplerFromEnv):
//     sdktrace.WithSampler(ParentBased(AlwaysSample())) unless a sampler
//     option is given.
//   - OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT, OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT,
//     OTEL_SPAN_EVENT_COUNT_LIMIT, OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT,
//     OTEL_SPAN_LINK_COUNT_LIMIT, OTEL_LINK_ATTRIBUTE_COUNT_LIMIT, and their
//     fallbacks OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT, OTEL_ATTRIBUTE_COUNT_LIMIT
//     (sdk/trace NewSpanLimits): sdktrace.WithRawSpanLimits(defaults).
//   - OTEL_BSP_SCHEDULE_DELAY, OTEL_BSP_EXPORT_TIMEOUT, OTEL_BSP_MAX_QUEUE_SIZE,
//     OTEL_BSP_MAX_EXPORT_BATCH_SIZE (sdk/trace NewBatchSpanProcessor): explicit
//     batch span processor options with the SDK defaults.
//   - OTEL_BLRP_SCHEDULE_DELAY, OTEL_BLRP_EXPORT_TIMEOUT, OTEL_BLRP_MAX_QUEUE_SIZE,
//     OTEL_BLRP_MAX_EXPORT_BATCH_SIZE (sdk/log newBatchConfig): explicit batch
//     processor options with the SDK defaults.
//   - OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT, OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT
//     (sdk/log newProviderConfig): explicit limits with the SDK defaults.
//   - OTEL_METRICS_EXEMPLAR_FILTER (sdk/metric meterProviderOptionsFromEnv):
//     sdkmetric.WithExemplarFilter(TraceBasedFilter) unless a filter option is
//     given.
//   - OTEL_GO_X_CARDINALITY_LIMIT (sdk/metric cardinalityLimitFromEnv):
//     sdkmetric.WithCardinalityLimit(2000), the SDK default.
//   - OTEL_*_EXPORTER, OTEL_EXPORTER_OTLP_* and every other exporter variable
//     (contrib autoexport and the OTLP exporters): no exporter or reader is
//     built from the environment.
//   - OTEL_TRACES_EXPORTER, OTEL_METRICS_EXPORTER, OTEL_LOGS_EXPORTER,
//     OTEL_TRACES_SAMPLER, OTEL_EXPORTER_OTLP_ENDPOINT (this package's startup
//     summary): read through settings.getenv, which returns "".
//
// Irrelevant under WithoutOTELEnv:
//   - OTEL_METRIC_EXPORT_INTERVAL, OTEL_METRIC_EXPORT_TIMEOUT (sdk/metric
//     NewPeriodicReader): no periodic reader is built; an injected one is
//     configured by the caller.
//   - OTEL_GO_X_RESOURCE (sdk/resource DefaultWithContext): the default
//     resource is never used, every provider gets an explicit resource.
//   - OTEL_GO_X_OBSERVABILITY, OTEL_GO_X_SELF_OBSERVABILITY (sdk, sdk/metric,
//     sdk/log): SDK self-observability metrics go to the global meter
//     provider, never to this SDK's pipelines.
//
// Not pinnable in v1.47.0 (no option overrides them):
//   - OTEL_RESOURCE_ATTRIBUTES, OTEL_SERVICE_NAME (sdk/trace, sdk/metric, and
//     sdk/log WithResource each merge resource.Environment() beneath the
//     given resource): [SDK.Resource] is environment-free and every key the
//     library resource defines (service.*, deployment.environment.name,
//     host.*, process.runtime.*, telemetry.sdk.*, container.*) keeps its
//     library value, but an ambient key absent from the library resource
//     appears on the telemetry the providers emit.
//   - OTEL_GO_X_PER_SERIES_START_TIMESTAMPS (sdk/metric aggregates): changes
//     the start timestamps of metric data points.
//   - OTEL_GO_X_DEPRECATED_RUNTIME_METRICS (contrib runtime): adds the
//     deprecated runtime metrics when runtime metrics are enabled.
func WithoutOTELEnv() Option {
	return func(s *settings) { s.ignoreEnv = true }
}

// getenv reads an environment variable unless the SDK ignores the
// environment.
func (s *settings) getenv(key string) string {
	if s.ignoreEnv {
		return ""
	}
	return os.Getenv(key)
}

// logExportEnabled reports whether the SDK builds an OTLP log pipeline.
// Under WithoutOTELEnv a log exporter is never built from the environment,
// so log export without an injected exporter is disabled.
func (s *settings) logExportEnabled() bool {
	return s.logExport && (s.logExporter != nil || !s.ignoreEnv)
}

// envOr returns the environment variable key, or fallback when it is unset,
// empty, or ignored under [WithoutOTELEnv].
func (s *settings) envOr(key, fallback string) string {
	if value := s.getenv(key); value != "" {
		return value
	}
	return fallback
}

// defaultSpanLimits returns the sdk/trace default span limits without
// consulting the OTEL_SPAN_*, OTEL_EVENT_*, OTEL_LINK_*, and OTEL_ATTRIBUTE_*
// variables that sdktrace.NewSpanLimits reads.
func defaultSpanLimits() sdktrace.SpanLimits {
	return sdktrace.SpanLimits{
		AttributeValueLengthLimit:   sdktrace.DefaultAttributeValueLengthLimit,
		AttributeValueDepthLimit:    sdktrace.DefaultAttributeValueDepthLimit,
		AttributeCountLimit:         sdktrace.DefaultAttributeCountLimit,
		EventCountLimit:             sdktrace.DefaultEventCountLimit,
		LinkCountLimit:              sdktrace.DefaultLinkCountLimit,
		AttributePerEventCountLimit: sdktrace.DefaultAttributePerEventCountLimit,
		AttributePerLinkCountLimit:  sdktrace.DefaultAttributePerLinkCountLimit,
	}
}

// traceBatchOptions pins batching to the SDK defaults under WithoutOTELEnv;
// explicit options win over the OTEL_BSP_* variables the batcher reads.
func traceBatchOptions(s *settings) []sdktrace.BatchSpanProcessorOption {
	if !s.ignoreEnv {
		return nil
	}
	return []sdktrace.BatchSpanProcessorOption{
		sdktrace.WithBatchTimeout(sdktrace.DefaultScheduleDelay * time.Millisecond),
		sdktrace.WithExportTimeout(sdktrace.DefaultExportTimeout * time.Millisecond),
		sdktrace.WithMaxQueueSize(sdktrace.DefaultMaxQueueSize),
		sdktrace.WithMaxExportBatchSize(sdktrace.DefaultMaxExportBatchSize),
	}
}

// Defaults of sdk/log v1.47.0 (batch.go and provider.go), which the package
// does not export.
const (
	defaultLogMaxQueueSize       = 2048
	defaultLogExportInterval     = time.Second
	defaultLogExportTimeout      = 30 * time.Second
	defaultLogExportMaxBatchSize = 512
	defaultLogAttrCountLimit     = 128
	defaultLogAttrValueLenLimit  = -1 // unlimited
)

// defaultCardinalityLimit is the sdk/metric v1.47.0 default, which the
// package does not export.
const defaultCardinalityLimit = 2000

// logBatchOptions pins log batching (OTEL_BLRP_*) to the SDK defaults under
// WithoutOTELEnv.
func logBatchOptions(s *settings) []sdklog.BatchProcessorOption {
	if !s.ignoreEnv {
		return nil
	}
	return []sdklog.BatchProcessorOption{
		sdklog.WithExportInterval(defaultLogExportInterval),
		sdklog.WithExportTimeout(defaultLogExportTimeout),
		sdklog.WithMaxQueueSize(defaultLogMaxQueueSize),
		sdklog.WithExportMaxBatchSize(defaultLogExportMaxBatchSize),
	}
}

// logProviderOptions pins log record limits (OTEL_LOGRECORD_*) to the SDK
// defaults under WithoutOTELEnv.
func logProviderOptions(s *settings) []sdklog.LoggerProviderOption {
	if !s.ignoreEnv {
		return nil
	}
	return []sdklog.LoggerProviderOption{
		sdklog.WithAttributeCountLimit(defaultLogAttrCountLimit),
		sdklog.WithAttributeValueLengthLimit(defaultLogAttrValueLenLimit),
	}
}

// meterProviderOptions pins the cardinality limit (OTEL_GO_X_CARDINALITY_LIMIT)
// to the SDK default under WithoutOTELEnv.
func meterProviderOptions(s *settings) []sdkmetric.Option {
	if !s.ignoreEnv {
		return nil
	}
	return []sdkmetric.Option{sdkmetric.WithCardinalityLimit(defaultCardinalityLimit)}
}
