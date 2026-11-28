/**
 * The resolved configuration: what each option, OTEL_* variable and default came to, in the order
 * option, then environment, then default.
 */
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  type Sampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace";
import {
  type ExporterKind,
  exporterError,
  invalidOptionError,
  piiHashKeyTypeError,
  unsupportedProtocolError,
} from "./errors.ts";
import { isBytes } from "./internal/bytes.ts";
import type { LogLevel } from "./log-values.ts";
import type { TelemetryOptions } from "./options.ts";
import { sanitizeEndpoint } from "./sanitize-endpoint.ts";

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

/** The trace samplers OTEL_TRACES_SAMPLER may name, as Go's SDK accepts them. */
export const KNOWN_SAMPLERS: ReadonlySet<string> = new Set([
  "always_on",
  "always_off",
  "traceidratio",
  "parentbased_always_on",
  "parentbased_always_off",
  "parentbased_traceidratio",
]);

/** The OTLP protocols libo11y ships. grpc is not one of them. */
export const SUPPORTED_PROTOCOLS: ReadonlySet<string> = new Set(["http/protobuf", "http/json"]);

/**
 * The export timeout when no variable sets one: the default shutdown deadline, where sdk-node uses
 * 30000 ms. A flush against an exporter that does not answer then gives up when the default
 * shutdown deadline does. An explicit OTEL_BSP_EXPORT_TIMEOUT, OTEL_BLRP_EXPORT_TIMEOUT or
 * OTEL_METRIC_EXPORT_TIMEOUT still wins.
 *
 * Upstream's batch processors and periodic reader arm an export timer that is not unref'd. It no
 * longer holds an exiting process: shutdown fails the exports still in flight when it settles,
 * which clears the timer (export-watch.ts).
 */
export const DEFAULT_EXPORT_TIMEOUT_MILLIS = 5000;

const SPAN_BATCH_DEFAULTS: BatchOptions = {
  scheduledDelayMillis: 5000,
  exportTimeoutMillis: DEFAULT_EXPORT_TIMEOUT_MILLIS,
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
};

// Go's pinned log batch values, which are also sdk-node's BLRP defaults, except the export timeout.
const LOG_BATCH_DEFAULTS: BatchOptions = {
  scheduledDelayMillis: 1000,
  exportTimeoutMillis: DEFAULT_EXPORT_TIMEOUT_MILLIS,
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
};

type Env = Readonly<Record<string, string | undefined>>;

function envString(env: Env, name: string): string {
  return (env[name] ?? "").trim();
}

const MAX_GO_INT = 9223372036854775807n;

// envInt reads an integer variable as otel-go's IntEnvOr does with strconv.Atoi: the raw value,
// untrimmed, must be an optional sign and decimal digits within Go's int range. Anything else is
// the default, and so is a negative value.
function envInt(env: Env, name: string, fallback: number): number {
  const raw = env[name] ?? "";
  if (!/^[+-]?[0-9]+$/.test(raw)) return fallback;
  const big = BigInt(raw);
  return big < 0n || big > MAX_GO_INT ? fallback : Number(big);
}

function batchFromEnv(env: Env, prefix: "OTEL_BSP" | "OTEL_BLRP", d: BatchOptions): BatchOptions {
  return {
    scheduledDelayMillis: envInt(env, `${prefix}_SCHEDULE_DELAY`, d.scheduledDelayMillis),
    exportTimeoutMillis: envInt(env, `${prefix}_EXPORT_TIMEOUT`, d.exportTimeoutMillis),
    maxQueueSize: envInt(env, `${prefix}_MAX_QUEUE_SIZE`, d.maxQueueSize),
    maxExportBatchSize: envInt(env, `${prefix}_MAX_EXPORT_BATCH_SIZE`, d.maxExportBatchSize),
  };
}

// exporterRoute reads OTEL_<SIGNAL>_EXPORTER: the first comma-separated value, trimmed and
// lowercased, defaulting to otlp. Anything but otlp, console or none fails as Go's autoexport does.
function exporterRoute(env: Env, name: string, kind: ExporterKind): SignalRoute {
  const first = envString(env, name)
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .find((v) => v !== "");
  const value = first ?? "otlp";
  if (value === "otlp" || value === "console" || value === "none") return value;
  throw exporterError(kind, new Error("unknown exporter or metrics producer"));
}

function ratioArg(env: Env): number {
  const raw = envString(env, "OTEL_TRACES_SAMPLER_ARG");
  const n = raw === "" ? Number.NaN : Number(raw);
  return Number.isNaN(n) || n < 0 || n > 1 ? 1 : n;
}

function samplerFromEnv(env: Env): { name: string; instance: Sampler } {
  const raw = envString(env, "OTEL_TRACES_SAMPLER").toLowerCase();
  const name = KNOWN_SAMPLERS.has(raw) ? raw : "parentbased_always_on";
  switch (name) {
    case "always_on":
      return { name, instance: new AlwaysOnSampler() };
    case "always_off":
      return { name, instance: new AlwaysOffSampler() };
    case "traceidratio":
      return { name, instance: new TraceIdRatioBasedSampler(ratioArg(env)) };
    case "parentbased_always_off":
      return { name, instance: new ParentBasedSampler({ root: new AlwaysOffSampler() }) };
    case "parentbased_traceidratio":
      return {
        name,
        instance: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratioArg(env)) }),
      };
    default:
      return { name, instance: new ParentBasedSampler({ root: new AlwaysOnSampler() }) };
  }
}

function exemplarFilterFrom(value: string): ResolvedConfig["exemplarFilter"] | undefined {
  const v = value.toLowerCase();
  return v === "trace_based" || v === "always_on" || v === "always_off" ? v : undefined;
}

/**
 * Resolves the configuration: each option, then its OTEL_* variable, then the default. In hermetic
 * mode env is ignored and a signal with nothing injected is "none". Throws EXPORTER for an unknown
 * OTEL_*_EXPORTER value and UNSUPPORTED_PROTOCOL for a signal routed to otlp over anything but
 * http/protobuf or http/json.
 */
export function resolveConfig(options: TelemetryOptions, ambient: Env): ResolvedConfig {
  const hermetic = options.hermetic ?? false;
  const env: Env = hermetic ? {} : ambient;
  const sdkDisabled = envString(env, "OTEL_SDK_DISABLED").toLowerCase() === "true";

  let traces: SignalRoute =
    options.spanProcessor !== undefined || options.spanExporter !== undefined
      ? "injected"
      : hermetic
        ? "none"
        : exporterRoute(env, "OTEL_TRACES_EXPORTER", "span exporter");
  let metrics: SignalRoute =
    options.metricReader !== undefined
      ? "injected"
      : hermetic
        ? "none"
        : exporterRoute(env, "OTEL_METRICS_EXPORTER", "metric reader");
  let logs: SignalRoute =
    options.logExport === false
      ? "none"
      : options.logExporter !== undefined || options.logProcessor !== undefined
        ? "injected"
        : hermetic
          ? "none"
          : exporterRoute(env, "OTEL_LOGS_EXPORTER", "log exporter");
  if (sdkDisabled) {
    traces = "none";
    metrics = "none";
    logs = "none";
  }

  const general = envString(env, "OTEL_EXPORTER_OTLP_PROTOCOL") || "http/protobuf";
  const protocol = {
    traces: envString(env, "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL") || general,
    metrics: envString(env, "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL") || general,
    logs: envString(env, "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL") || general,
  };
  for (const [signal, route] of [
    ["traces", traces],
    ["metrics", metrics],
    ["logs", logs],
  ] as const) {
    if (route === "otlp" && !SUPPORTED_PROTOCOLS.has(protocol[signal])) {
      throw unsupportedProtocolError(protocol[signal], signal);
    }
  }

  const endpoint = (name: string): string | undefined => {
    const raw = env[name] ?? "";
    return raw === "" ? undefined : sanitizeEndpoint(raw);
  };

  const runtimeMetrics = (options.runtimeMetrics ?? true) && !sdkDisabled;
  return {
    hermetic,
    sdkDisabled,
    traces,
    metrics,
    logs,
    protocol,
    endpoints: {
      endpoint: endpoint("OTEL_EXPORTER_OTLP_ENDPOINT"),
      traces_endpoint: endpoint("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
      metrics_endpoint: endpoint("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"),
      logs_endpoint: endpoint("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"),
    },
    sampler:
      options.sampler !== undefined
        ? { name: options.sampler.toString(), instance: options.sampler }
        : samplerFromEnv(env),
    exemplarFilter:
      options.exemplarFilter ??
      exemplarFilterFrom(envString(env, "OTEL_METRICS_EXEMPLAR_FILTER")) ??
      "trace_based",
    logLevel: options.logLevel ?? "info",
    console: options.console === false ? "off" : (options.console ?? "json"),
    batch: {
      spans: batchFromEnv(env, "OTEL_BSP", SPAN_BATCH_DEFAULTS),
      logs: hermetic ? LOG_BATCH_DEFAULTS : batchFromEnv(env, "OTEL_BLRP", LOG_BATCH_DEFAULTS),
    },
    metricExport: {
      intervalMillis: envInt(env, "OTEL_METRIC_EXPORT_INTERVAL", 60000),
      timeoutMillis: envInt(env, "OTEL_METRIC_EXPORT_TIMEOUT", DEFAULT_EXPORT_TIMEOUT_MILLIS),
    },
    runtimeMetrics,
    startupSummary: options.startupSummary ?? true,
  };
}

/** The values each option with a closed set accepts, in the order options.ts declares the options. */
const CLOSED_OPTIONS: readonly (readonly [keyof TelemetryOptions, readonly (string | boolean)[]])[] = [
  ["strictIdentity", [true, false]],
  ["piiMode", ["drop", "hash", "allow"]],
  ["logLevel", ["trace", "debug", "info", "warn", "error", "fatal"]],
  ["console", ["json", "text", false]],
  ["captureConsole", [true, false]],
  ["logExport", [true, false]],
  ["exemplarFilter", ["trace_based", "always_on", "always_off"]],
  ["runtimeMetrics", [true, false]],
  ["startupSummary", [true, false]],
  ["hermetic", [true, false]],
];

/**
 * Checks every option that takes a closed set of values, and throws INVALID_OPTION for the first
 * one, in declaration order, whose value is outside its set. An option that is undefined or null
 * is not given and takes its default. A boolean option must be a boolean: the string "false" is
 * not false, and reading it as true would do the opposite of what was asked.
 *
 * Without this, a JavaScript caller or a value read from configuration was accepted in silence:
 * logLevel "verbose" dropped every record, and console "pretty" wrote text. The variables of the
 * environment are not checked here. Each has its own rule in resolveConfig.
 *
 * The propagators option is checked last: it must be an array, and each member a propagator.
 *
 * The PII hash key is checked first, in every PII mode: a key that is given and is not a
 * Uint8Array throws PII_HASH_KEY. A string from an environment variable is the usual case, and
 * converting it would key every token with nothing.
 */
export function validateOptions(options: TelemetryOptions): void {
  const key: unknown = options.piiHashKey;
  if (key !== undefined && key !== null && !isBytes(key)) throw piiHashKeyTypeError(key);
  for (const [option, allowed] of CLOSED_OPTIONS) {
    const value: unknown = options[option];
    if (value === undefined || value === null) continue;
    if (!allowed.includes(value as string | boolean)) throw invalidOptionError(option, value, allowed);
  }
  validatePropagators(options.propagators);
}

// Whether value can be used as a propagator. It reads the three members and calls none of them.
function isPropagator(value: unknown): boolean {
  try {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
    const p = value as { inject?: unknown; extract?: unknown; fields?: unknown };
    return (
      typeof p.inject === "function" && typeof p.extract === "function" && typeof p.fields === "function"
    );
  } catch {
    return false;
  }
}

// The propagators option is an array of propagators. A single propagator has no length, so it used
// to read as "not given" and the default was used in silence, and a name such as "tracecontext"
// failed later with a TypeError from inside the SDK.
function validatePropagators(given: unknown): void {
  if (given === undefined || given === null) return;
  if (!Array.isArray(given)) throw invalidOptionError("propagators", given, ["an array of propagators"]);
  for (let i = 0; i < given.length; i++) {
    const member: unknown = given[i];
    if (!isPropagator(member)) {
      throw invalidOptionError(`propagators[${i}]`, member, ["a propagator with inject, extract and fields"]);
    }
  }
}
