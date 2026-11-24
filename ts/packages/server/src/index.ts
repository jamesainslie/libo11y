/**
 * The libo11y server platform for Bun and Node: AsyncLocalStorage context, resource detection, OTLP
 * exporters built from OTEL_* with exemplars, setup, application registry loading, signal handling,
 * runtime metrics, and HTTP server and client instrumentation.
 */

export {
  type LifecycleOptions,
  type Logger,
  O11yError,
  type O11yErrorCode,
  type SignalReport,
  type Telemetry,
  type TelemetryOptions,
} from "@libo11y/core";
export { createContextManager } from "./context.ts";
export { type FetchOptions, instrumentFetch } from "./fetch.ts";
export { OtlpProtobufMetricsSerializer } from "./otlp-proto-metrics.ts";
export { serverPlatform } from "./platform.ts";
export { loadAppRegistry } from "./registry.ts";
export { instrumentServe, type ServeOptions } from "./serve.ts";
export { createTelemetry, setup } from "./setup.ts";
export { type ShutdownOnSignalsOptions, shutdownOnSignals } from "./signals.ts";
