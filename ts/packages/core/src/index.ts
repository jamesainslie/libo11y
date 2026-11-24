/**
 * The platform-neutral libo11y core: configuration, identity, the sensitivity policy and the signal
 * pipelines over the OpenTelemetry JS SDK. Runtime packages such as `@libo11y/server` supply the
 * Platform.
 */

export type { BatchOptions, ResolvedConfig, SignalRoute } from "./config.ts";
export { O11yError, type O11yErrorCode } from "./errors.ts";
export type { LogAttributes, LogLevel, LogValue } from "./log-values.ts";
export type {
  ExporterRequest,
  ExporterSet,
  Platform,
  PlatformConsole,
  ResourceLayers,
  RuntimeMetrics,
} from "./platform.ts";
