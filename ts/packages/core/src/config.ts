/**
 * The resolved configuration: what each option, OTEL_* variable and default came to, in the order
 * option, then environment, then default.
 */
import type { Sampler } from "@opentelemetry/sdk-trace";
import type { LogLevel } from "./log-values.ts";

/** Where a signal's records go. "injected" means the caller supplied the exporter or reader. */
export type SignalRoute = "otlp" | "console" | "none" | "injected";

/** Batch processor settings, as BatchSpanProcessor and BatchLogRecordProcessor take them. */
export interface BatchOptions {
  readonly scheduledDelayMillis: number;
  readonly exportTimeoutMillis: number;
  readonly maxQueueSize: number;
  readonly maxExportBatchSize: number;
}

/** The fully resolved configuration a Platform builds exporters from. */
export interface ResolvedConfig {
  readonly hermetic: boolean;
  readonly sdkDisabled: boolean;
  readonly traces: SignalRoute;
  readonly metrics: SignalRoute;
  /** "none" when logExport is false. */
  readonly logs: SignalRoute;
  /** The OTLP protocol per signal. Defaults to "http/protobuf". */
  readonly protocol: { readonly traces: string; readonly metrics: string; readonly logs: string };
  /** The OTLP endpoints from the environment, sanitized for display. Undefined when unset. */
  readonly endpoints: Readonly<
    Record<"endpoint" | "traces_endpoint" | "metrics_endpoint" | "logs_endpoint", string | undefined>
  >;
  /** The sampler, and the name the startup summary reports for it. */
  readonly sampler: { readonly name: string; readonly instance: Sampler };
  readonly exemplarFilter: "trace_based" | "always_on" | "always_off";
  readonly logLevel: LogLevel;
  readonly console: "json" | "text" | "off";
  readonly batch: { readonly spans: BatchOptions; readonly logs: BatchOptions };
  readonly metricExport: { readonly intervalMillis: number; readonly timeoutMillis: number };
  readonly runtimeMetrics: boolean;
  readonly startupSummary: boolean;
}
