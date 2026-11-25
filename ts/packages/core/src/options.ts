/** The options createTelemetryWith and setupWith take. Each one beats its OTEL_* variable. */
import type { AppRegistry, CompiledAppRegistry } from "@libo11y/spec";
import type { Attributes, TextMapPropagator } from "@opentelemetry/api";
import type { LogRecordExporter, LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { IMetricReader, ViewOptions } from "@opentelemetry/sdk-metrics";
import type { Sampler, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace";
import type { LogLevel } from "./log-values.ts";
import type { PIIMode } from "./policy.ts";

/** Renames or replaces a log attribute before classification. Return undefined to drop it. */
export type AttrReplacer = (
  key: string,
  value: unknown,
  groups: readonly string[],
) => readonly [string, unknown] | undefined;

/** The libo11y telemetry options. */
export interface TelemetryOptions {
  /** service.name. Else OTEL_SERVICE_NAME, else service.name in OTEL_RESOURCE_ATTRIBUTES. */
  serviceName?: string;
  /** service.version. Else the environment, else "0.0.0-unknown", which the canary reports. */
  serviceVersion?: string;
  serviceNamespace?: string;
  /** deployment.environment.name. Else deployment.environment.name in OTEL_RESOURCE_ATTRIBUTES. */
  environment?: string;
  /** Environments accepted beyond production, staging, development and test. */
  environmentValues?: readonly string[];
  /** Fail on a missing or invalid identity. Default true; false counts violations instead. */
  strictIdentity?: boolean;
  /** Resource attributes. They beat the identity options and every other layer. */
  resourceAttributes?: Attributes;
  /** Application registries, each validated if it is not compiled already. */
  registry?: AppRegistry | CompiledAppRegistry | readonly (AppRegistry | CompiledAppRegistry)[];
  /** How PII is handled. Default "drop". "hash" needs piiHashKey. */
  piiMode?: PIIMode;
  /** The HMAC key for hash mode, at least 32 bytes. */
  piiHashKey?: Uint8Array;
  /** The lowest level logged. Default "info". */
  logLevel?: LogLevel;
  /** The console sink format, or false for none. Default "json". */
  console?: "json" | "text" | false;
  /** Capture the platform console into the logger. Default false. */
  captureConsole?: boolean;
  attrReplacer?: AttrReplacer;
  /** Export logs over OTLP. Default true. */
  logExport?: boolean;
  /** The sampler. Default OTEL_TRACES_SAMPLER, else parentbased_always_on. */
  sampler?: Sampler;
  /**
   * The propagators. Empty means none given: then OTEL_PROPAGATORS selects tracecontext, baggage
   * or none by name, and without it the default is W3C trace context plus baggage. Any other name
   * in the variable fails with UNSUPPORTED_PROPAGATOR, and this option is the way to use one.
   */
  propagators?: readonly TextMapPropagator[];
  views?: readonly ViewOptions[];
  /** Explicit histogram boundaries by instrument name. */
  histogramBuckets?: Readonly<Record<string, readonly number[]>>;
  /** Default OTEL_METRICS_EXEMPLAR_FILTER, else "trace_based". */
  exemplarFilter?: "trace_based" | "always_on" | "always_off";
  /** Runtime metrics, where the platform has them. Default true. */
  runtimeMetrics?: boolean;
  /** Emit the o11y.telemetry.configured canary at setup. Default true. */
  startupSummary?: boolean;
  /** Ignore every OTEL_* variable, OTEL_PROPAGATORS included (Go WithoutOTELEnv). A signal with nothing injected is off. */
  hermetic?: boolean;
  spanExporter?: SpanExporter;
  spanProcessor?: SpanProcessor;
  metricReader?: IMetricReader;
  logExporter?: LogRecordExporter;
  /**
   * A log record processor, after the redacting processor and before the batch processor of
   * logExporter, so it sees each classified record synchronously in onEmit (Go WithExtraLogHandler).
   */
  logProcessor?: LogRecordProcessor;
}
