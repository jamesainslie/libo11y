/**
 * The platform-neutral libo11y core: configuration, identity, the sensitivity policy and the signal
 * pipelines over the OpenTelemetry JS SDK. Runtime packages such as `@libo11y/server` supply the
 * Platform.
 */

export type { BatchOptions, ResolvedConfig, SignalRoute } from "./config.ts";
export { O11yError, type O11yErrorCode } from "./errors.ts";
export {
  type DataPointWithExemplars,
  type Exemplar,
  type ExemplarFilter,
  type ExemplarKind,
  type ExemplarMeasurement,
  ExemplarStore,
  type ExemplarStoreOptions,
  exemplarMetricExporter,
  exemplarsOf,
  type ResourceMetricsWithExemplars,
} from "./exemplars.ts";
export type { LogAttributes, LogLevel, LogValue } from "./log-values.ts";
export { forceEmit, type Logger } from "./logger.ts";
export type { AttrReplacer, TelemetryOptions } from "./options.ts";
export {
  type OtlpAnyValueJson,
  type OtlpDataPointJson,
  type OtlpDataPointsJson,
  type OtlpExemplarJson,
  OtlpJsonMetricsSerializer,
  type OtlpKeyValueJson,
  type OtlpMetricJson,
  type OtlpMetricsRequestJson,
  type OtlpResourceMetricsJson,
  type OtlpScopeMetricsJson,
  toOtlpMetricsObject,
} from "./otlp-json-metrics.ts";
export type {
  ExporterRequest,
  ExporterSet,
  Platform,
  PlatformConsole,
  RecordingGate,
  ResourceLayers,
  RuntimeMetrics,
} from "./platform.ts";
export type { PIIMode } from "./policy.ts";
export { currentRecord, type EventEmitter, startRecord, type WideRecord } from "./record.ts";
export {
  createTelemetryWith,
  type LifecycleOptions,
  type Signal,
  type SignalReport,
  setupWith,
  type Telemetry,
} from "./telemetry.ts";
