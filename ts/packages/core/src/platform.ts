/**
 * The Platform is everything runtime-specific core needs: the environment, resource detection, the
 * context manager, exporters, the console and diagnostic streams, hashing and UUIDs. Core itself
 * imports nothing runtime-specific, so one core serves servers, browsers and extensions.
 */
import type { Attributes, ContextManager, MeterProvider } from "@opentelemetry/api";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import type { IMetricReader } from "@opentelemetry/sdk-metrics";
import type { SpanExporter } from "@opentelemetry/sdk-trace";
import type { ResolvedConfig } from "./config.ts";
import type { ExemplarStore } from "./exemplars.ts";

/** The resource attributes a platform detects, in two layers merged lowest first. */
export interface ResourceLayers {
  /** Attributes the platform detected itself (telemetry.sdk.*, host, runtime, container). */
  readonly detected: Attributes;
  /** Attributes from OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME. Empty in hermetic mode. */
  readonly fromEnv: Attributes;
}

/** What core asks a platform to build exporters for. */
export interface ExporterRequest {
  readonly config: ResolvedConfig;
  /**
   * The exemplar store. A platform that builds a periodic metric reader wraps its exporter with
   * exemplarMetricExporter(exporter, exemplars), so exported points carry exemplars.
   */
  readonly exemplars: ExemplarStore;
}

/** The exporters a platform built, one per signal the configuration routes to otlp or console. */
export interface ExporterSet {
  readonly spanExporter?: SpanExporter;
  readonly metricReader?: IMetricReader;
  readonly logExporter?: LogRecordExporter;
}

/** The console methods console capture patches. */
export interface PlatformConsole {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
}

/** A running runtime-metrics collection. */
export interface RuntimeMetrics {
  stop(): void;
}

/** Everything runtime-specific core needs. */
export interface Platform {
  /** The platform's name: "server", later "web" and "webext". */
  readonly name: string;
  /** The OTEL_* variables. Never read in hermetic mode. */
  env(): Readonly<Record<string, string | undefined>>;
  /** Detects the resource layers. fromEnv is empty when hermetic is true. */
  detectResource(hermetic: boolean): Promise<ResourceLayers>;
  /** A fresh context manager, not yet enabled. */
  contextManager(): ContextManager;
  /** Builds the exporters for the signals the configuration routes to "otlp" or "console". */
  buildExporters(req: ExporterRequest): ExporterSet;
  /** Writes one console sink line to stdout. May throw; the startup canary relies on it. */
  writeConsoleLine(line: string): void;
  /** Writes one diagnostic line to stderr, for the error handler. */
  writeDiagnosticLine(line: string): void;
  /** The SHA-1 digest of data. */
  sha1(data: Uint8Array): Promise<Uint8Array>;
  /** A random UUIDv4, lowercase and hyphenated. */
  randomUUID(): string;
  /** HMAC-SHA256, when the platform has a native one. Core falls back to its own. */
  hmacSha256?(key: Uint8Array, data: Uint8Array): Uint8Array;
  /** Starts runtime metrics on meterProvider, when the platform has any. */
  startRuntimeMetrics?(meterProvider: MeterProvider): RuntimeMetrics;
  /** The console object captureConsole patches. */
  console?: PlatformConsole;
}
