/**
 * The lifecycle. createTelemetryWith builds the providers, the logger and the summary without
 * touching any global, as Go's New does. setupWith takes the process-wide guard, builds, emits the
 * o11y.telemetry.configured canary through the strict path, and only then installs the globals:
 * the context manager, tracer, meter, logger and propagator providers, then the error handler.
 *
 * shutdown stops logs, metrics and traces concurrently under one deadline, so a hung exporter on
 * one signal cannot spend the others' budget. Every caller gets the same promise, which never
 * rejects. forceFlush runs the signals in turn under the same deadline handling.
 */
import { EVENT_TELEMETRY_CONFIGURED, EVENT_TELEMETRY_DROPPED } from "@libo11y/spec";
import {
  type LoggerProvider as ApiLoggerProvider,
  type TracerProvider as ApiTracerProvider,
  type Context,
  context,
  createNoopLogger,
  type Exception,
  logs,
  type MeterProvider,
  metrics,
  propagation,
  ROOT_CONTEXT,
  type TextMapPropagator,
  trace,
} from "@opentelemetry/api";
import { loggingErrorHandler, setGlobalErrorHandler } from "@opentelemetry/core";
import type { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  AggregationType,
  type IMetricReader,
  MeterProvider as SdkMeterProvider,
  type ViewOptions,
} from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, type SpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { type ResolvedConfig, resolveConfig } from "./config.ts";
import { captureConsole } from "./console-capture.ts";
import { ConsoleSink, formatTextLine } from "./console-sink.ts";
import { alreadySetupError, canaryRejectedError, piiHashKeyError } from "./errors.ts";
import { emitEvent, eventAttributes } from "./events.ts";
import { ExemplarStore } from "./exemplars.ts";
import { gatedLogRecordProcessor, gatedSampler, gatedSpanProcessor } from "./gate.ts";
import { buildResource } from "./identity.ts";
import { seams } from "./internal/seams.ts";
import { registerExemplarStore } from "./internal/stores.ts";
import type { LogAttributes } from "./log-values.ts";
import { CoreLogger, forceEmit, type Logger, LogPipeline } from "./logger.ts";
import { RedactingLogRecordProcessor } from "./logs-processor.ts";
import { PolicyMeterProvider } from "./metrics.ts";
import type { TelemetryOptions } from "./options.ts";
import type { ExporterSet, Platform, RuntimeMetrics } from "./platform.ts";
import { compileRegistries, MIN_PII_HASH_KEY_LENGTH, SensitivityPolicy } from "./policy.ts";
import { BaggageEgressPropagator, buildPropagator } from "./propagation.ts";
import { redactingSpanExporter, redactingSpanProcessor } from "./spans.ts";
import { buildSummary } from "./summary.ts";
import { VERSION } from "./version.ts";
import { CORE_SCOPE, ViolationRecorder } from "./violations.ts";

/** A telemetry signal. */
export type Signal = "traces" | "metrics" | "logs";

/**
 * What a shutdown or flush achieved: ok when nothing failed, else one error per failed signal.
 * "lifecycle" carries a failure of the shutdown itself rather than of one signal.
 */
export interface SignalReport {
  readonly ok: boolean;
  readonly errors: readonly { readonly signal: Signal | "lifecycle"; readonly error: unknown }[];
}

/** Options for shutdown and forceFlush. */
export interface LifecycleOptions {
  /** The deadline for all signals together. Default 5000. */
  readonly timeoutMillis?: number;
}

/** A running libo11y telemetry pipeline. */
export interface Telemetry {
  readonly logger: Logger;
  readonly tracerProvider: ApiTracerProvider;
  /** The policy-wrapping meter provider: every measurement is classified and sampled for exemplars. */
  readonly meterProvider: MeterProvider;
  readonly loggerProvider: ApiLoggerProvider;
  /** The configured propagator, wrapped by the baggage egress filter. */
  readonly propagator: TextMapPropagator;
  readonly resource: Resource;
  /** The resolved configuration on one line, as the canary reports it. */
  effectiveConfig(): string;
  /** Emits a contract-bearing event: a forced info record named name, correlated to ctx. */
  event(name: string, attrs?: LogAttributes, ctx?: Context): void;
  /** Exports everything buffered, signal by signal. Never rejects. */
  forceFlush(opts?: LifecycleOptions): Promise<SignalReport>;
  /** Stops every signal. Idempotent: every call returns the first call's promise, which never rejects. */
  shutdown(opts?: LifecycleOptions): Promise<SignalReport>;
}

const DEFAULT_TIMEOUT_MILLIS = 5000;

/** The longest delay a timer takes: setTimeout treats anything larger as 1 ms. */
const MAX_TIMEOUT_MILLIS = 2 ** 31 - 1;

// clampTimeout bounds a caller's deadline to what a timer can wait: negative is 0, Infinity and
// anything past the timer maximum is the maximum, NaN is the default.
function clampTimeout(ms: number | undefined): number {
  if (ms === undefined || Number.isNaN(ms)) return DEFAULT_TIMEOUT_MILLIS;
  return Math.min(Math.max(ms, 0), MAX_TIMEOUT_MILLIS);
}
const GUARD: unique symbol = Symbol.for("libo11y.setup") as never;

type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

// The timer functions exist in every runtime core targets, but the ES library types do not
// declare them.
const timers = globalThis as unknown as Timers;

function causeText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) return String(err.message);
  return String(err);
}

function wrap(prefix: string, err: unknown): Error {
  return new Error(`${prefix}: ${causeText(err)}`, { cause: err });
}

// deadline resolves after ms. Its timer is unref'd where the runtime allows, so a pending deadline
// never holds the process open.
// A timer that cannot be armed throws here, to the caller, rather than rejecting expired.
function deadline(ms: number): { readonly expired: Promise<void>; cancel(): void } {
  let fire: () => void = () => {};
  const expired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  const handle = timers.setTimeout(() => fire(), ms);
  (handle as { unref?: () => void } | undefined)?.unref?.();
  return { expired, cancel: () => timers.clearTimeout(handle) };
}

const EXPIRED: unique symbol = Symbol("expired") as never;

async function settle(step: () => Promise<void>, expired: Promise<void>): Promise<unknown> {
  try {
    const result = await Promise.race([step().then(() => undefined), expired.then(() => EXPIRED)]);
    return result;
  } catch (err) {
    return err ?? new Error("unknown error");
  }
}

function report(errors: { signal: Signal | "lifecycle"; error: unknown }[]): SignalReport {
  return { ok: errors.length === 0, errors };
}

// The default error handler: Go's, a token bucket of 5 refilled one per 30 s, writing slog text
// lines to the diagnostic stream, outside the pipeline so a failing exporter cannot recurse.
function rateLimitedErrorHandler(platform: Platform): (err: Exception) => void {
  const burst = 5;
  const refillMillis = 30_000;
  let tokens = burst;
  let last = Date.now();
  let suppressed = 0;
  return (err) => {
    if (err === undefined || err === null) return;
    const now = Date.now();
    tokens = Math.min(burst, tokens + (now - last) / refillMillis);
    last = now;
    if (tokens < 1) {
      suppressed++;
      return;
    }
    tokens--;
    const attributes: LogAttributes =
      suppressed > 0 ? { error: causeText(err), suppressed } : { error: causeText(err) };
    suppressed = 0;
    try {
      platform.writeDiagnosticLine(
        formatTextLine({ time: new Date(now), level: "warn", msg: "o11y: telemetry error", attributes }),
      );
    } catch {
      // The diagnostic stream is the last resort; nothing is left to report to.
    }
  };
}

function wants(route: ResolvedConfig["traces"]): boolean {
  return route === "otlp" || route === "console";
}

function bucketViews(buckets: Readonly<Record<string, readonly number[]>> | undefined): ViewOptions[] {
  return Object.entries(buckets ?? {}).map(([name, boundaries]) => ({
    instrumentName: name,
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: [...boundaries] },
    },
  }));
}

const NOOP_LOGGER_PROVIDER: ApiLoggerProvider = { getLogger: () => createNoopLogger() };

interface Parts {
  readonly config: ResolvedConfig;
  readonly platform: Platform;
  readonly resource: Resource;
  readonly pipeline: LogPipeline;
  readonly logger: CoreLogger;
  readonly sdkMeterProvider: SdkMeterProvider;
  readonly meterProvider: PolicyMeterProvider;
  readonly tracerProvider: TracerProvider;
  readonly loggerProvider: LoggerProvider | undefined;
  readonly propagator: TextMapPropagator;
  readonly exemplars: ExemplarStore;
  readonly summaryAttributes: LogAttributes;
  readonly effectiveConfig: string;
  readonly runtime: RuntimeMetrics | undefined;
  readonly restoreConsole: (() => void) | undefined;
}

/** What setupWith installed, so shutdown removes only that. */
interface Installed {
  context: boolean;
  tracer: boolean;
  meter: boolean;
  logger: boolean;
  propagator: boolean;
}

class TelemetryHandle implements Telemetry {
  readonly logger: Logger;
  readonly tracerProvider: ApiTracerProvider;
  readonly meterProvider: MeterProvider;
  readonly loggerProvider: ApiLoggerProvider;
  readonly propagator: TextMapPropagator;
  readonly resource: Resource;
  readonly parts: Parts;
  installed: Installed | undefined;
  /** Stops waiting for the gate's first open, while the canary's OTLP leg is deferred. */
  stopDeferredCanary: (() => void) | undefined;
  private shutdownPromise: Promise<SignalReport> | undefined;

  constructor(parts: Parts) {
    this.parts = parts;
    this.logger = parts.logger;
    this.tracerProvider = parts.tracerProvider;
    this.meterProvider = parts.meterProvider;
    this.loggerProvider = parts.loggerProvider ?? NOOP_LOGGER_PROVIDER;
    this.propagator = parts.propagator;
    this.resource = parts.resource;
  }

  effectiveConfig(): string {
    return this.parts.effectiveConfig;
  }

  event(name: string, attrs?: LogAttributes, ctx?: Context): void {
    emitEvent(this.parts.pipeline, name, attrs, ctx);
  }

  private steps(): { signal: Signal; shutdown: () => Promise<void>; flush: () => Promise<void> }[] {
    const { loggerProvider: lp, sdkMeterProvider: mp, tracerProvider: tp } = this.parts;
    const steps: { signal: Signal; shutdown: () => Promise<void>; flush: () => Promise<void> }[] = [];
    if (lp !== undefined)
      steps.push({ signal: "logs", shutdown: () => lp.shutdown(), flush: () => lp.forceFlush() });
    steps.push(
      { signal: "metrics", shutdown: () => mp.shutdown(), flush: () => mp.forceFlush() },
      { signal: "traces", shutdown: () => tp.shutdown(), flush: () => tp.forceFlush() },
    );
    return steps;
  }

  forceFlush(opts?: LifecycleOptions): Promise<SignalReport> {
    return this.runFlush(clampTimeout(opts?.timeoutMillis)).catch((err: unknown) =>
      report([{ signal: "lifecycle", error: err }]),
    );
  }

  private async runFlush(timeoutMillis: number): Promise<SignalReport> {
    const timer = deadline(timeoutMillis);
    const errors: { signal: Signal; error: unknown }[] = [];
    try {
      for (const step of this.steps()) {
        const outcome = await settle(step.flush, timer.expired);
        if (outcome === EXPIRED)
          errors.push({
            signal: step.signal,
            error: new Error(`o11y: flush ${step.signal}: deadline exceeded`),
          });
        else if (outcome !== undefined)
          errors.push({ signal: step.signal, error: wrap(`o11y: flush ${step.signal}`, outcome) });
      }
    } finally {
      timer.cancel();
    }
    return report(errors);
  }

  shutdown(opts?: LifecycleOptions): Promise<SignalReport> {
    this.shutdownPromise ??= this.runShutdown(clampTimeout(opts?.timeoutMillis)).catch((err: unknown) => {
      // runShutdown settles every signal itself, so this is a failure of the shutdown machinery.
      // A global telemetry still gives its globals and the guard back.
      if (this.installed !== undefined) {
        try {
          uninstall(this.installed);
        } finally {
          releaseGuard();
        }
      }
      return report([{ signal: "lifecycle", error: err }]);
    });
    return this.shutdownPromise;
  }

  private async runShutdown(timeoutMillis: number): Promise<SignalReport> {
    try {
      this.stopDeferredCanary?.();
    } catch {
      // Unsubscribing from the gate is best effort.
    }
    this.stopDeferredCanary = undefined;
    try {
      this.parts.restoreConsole?.();
    } catch {
      // Restoring the console is best effort.
    }
    const timer = deadline(timeoutMillis);
    const steps = this.steps();
    let outcomes: unknown[];
    try {
      outcomes = await Promise.all(steps.map((s) => settle(s.shutdown, timer.expired)));
    } finally {
      timer.cancel();
      // Runtime metrics stop only after the meter provider's final collection, so a process that
      // exits before its first periodic export still reports them.
      try {
        this.parts.runtime?.stop();
      } catch {
        // Stopping runtime metrics is best effort.
      }
    }
    const errors: { signal: Signal; error: unknown }[] = [];
    steps.forEach((step, i) => {
      const outcome = outcomes[i];
      if (outcome === undefined) return;
      errors.push({
        signal: step.signal,
        error:
          outcome === EXPIRED
            ? new Error(`o11y: shutdown ${step.signal}: deadline exceeded`)
            : wrap(`o11y: shutdown ${step.signal}`, outcome),
      });
    });
    // The OTLP leg is down, so the loss reaches the console sink only.
    for (const { signal, error } of errors) {
      try {
        emitEvent(
          this.parts.pipeline,
          EVENT_TELEMETRY_DROPPED,
          {
            "o11y.signal": signal,
            "error.type": error instanceof Error ? error.constructor.name : typeof error,
          },
          ROOT_CONTEXT,
          { consoleOnly: true },
        );
      } catch {
        // Delivery is best effort.
      }
    }
    if (this.installed !== undefined) {
      try {
        uninstall(this.installed);
      } finally {
        releaseGuard();
      }
    }
    return report(errors);
  }
}

function uninstall(installed: Installed): void {
  if (installed.propagator) propagation.disable();
  if (installed.logger) logs.disable();
  if (installed.meter) metrics.disable();
  if (installed.tracer) trace.disable();
  if (installed.context) context.disable();
  setGlobalErrorHandler(loggingErrorHandler());
}

function selectExporters(config: ResolvedConfig, options: TelemetryOptions, built: ExporterSet) {
  const traces = config.traces;
  return {
    spanProcessor: traces === "none" ? undefined : options.spanProcessor,
    spanExporter:
      traces === "none"
        ? undefined
        : (options.spanExporter ?? (wants(traces) ? built.spanExporter : undefined)),
    metricReader:
      config.metrics === "none"
        ? undefined
        : (options.metricReader ?? (wants(config.metrics) ? built.metricReader : undefined)),
    logExporter:
      config.logs === "none"
        ? undefined
        : (options.logExporter ?? (wants(config.logs) ? built.logExporter : undefined)),
    logProcessor: config.logs === "none" ? undefined : options.logProcessor,
  };
}

/**
 * Builds a Telemetry without touching any global and without the startup canary (Go New). Throws
 * O11yError for a bad configuration or identity.
 */
export async function createTelemetryWith(options: TelemetryOptions, platform: Platform): Promise<Telemetry> {
  return handleFor(await build(options, platform));
}

function handleFor(parts: Parts): TelemetryHandle {
  const handle = new TelemetryHandle(parts);
  registerExemplarStore(handle, parts.exemplars);
  return handle;
}

async function build(options: TelemetryOptions, platform: Platform): Promise<Parts> {
  const pii = options.piiMode ?? "drop";
  if (pii === "hash" && (options.piiHashKey?.length ?? 0) < MIN_PII_HASH_KEY_LENGTH) throw piiHashKeyError();
  let policy = SensitivityPolicy.create({
    pii,
    registries: compileRegistries(options.registry),
    ...(options.piiHashKey === undefined ? {} : { key: options.piiHashKey }),
    ...(platform.hmacSha256 === undefined ? {} : { hmac: platform.hmacSha256.bind(platform) }),
  });

  const config = resolveConfig(options, options.hermetic === true ? {} : platform.env());
  const layers = await platform.detectResource(config.hermetic);
  const built = await buildResource(options, layers, policy, platform);
  const resource = built.resource;

  const propagator = new BaggageEgressPropagator(
    buildPropagator(options.propagators),
    seams.baggageEgress ?? (() => true),
  );

  // With metrics off nothing can read the store, so it samples nothing.
  const exemplars = new ExemplarStore({
    filter: config.metrics === "none" || config.sdkDisabled ? "always_off" : config.exemplarFilter,
  });
  const needsPlatform = wants(config.traces) || wants(config.metrics) || wants(config.logs);
  const exporters = selectExporters(
    config,
    options,
    needsPlatform ? platform.buildExporters({ config, exemplars }) : {},
  );

  const readers: IMetricReader[] = exporters.metricReader === undefined ? [] : [exporters.metricReader];
  const sdkMeterProvider = new SdkMeterProvider({
    resource,
    readers,
    views: [...(options.views ?? []), ...bucketViews(options.histogramBuckets)],
  });
  const violations = new ViolationRecorder(sdkMeterProvider);
  policy = policy.withRecorder(violations);
  for (const [rule, n] of built.violations) violations.add("resource", rule, n);
  const meterProvider = new PolicyMeterProvider(sdkMeterProvider, policy, exemplars, platform.gate);

  let runtime: RuntimeMetrics | undefined;
  let tracerProvider: TracerProvider | undefined;
  let loggerProvider: LoggerProvider | undefined;
  let restoreConsole: (() => void) | undefined;
  try {
    if (config.runtimeMetrics && platform.startRuntimeMetrics !== undefined) {
      try {
        runtime = platform.startRuntimeMetrics(meterProvider);
      } catch (err) {
        throw wrap("o11y: starting runtime metrics", err);
      }
    }

    const spanProcessors: SpanProcessor[] = [];
    if (exporters.spanProcessor !== undefined) {
      const counting = exporters.spanExporter === undefined ? policy : policy.silent();
      spanProcessors.push(redactingSpanProcessor(exporters.spanProcessor, counting));
    }
    if (exporters.spanExporter !== undefined) {
      spanProcessors.push(
        new BatchSpanProcessor({
          exporter: redactingSpanExporter(exporters.spanExporter, policy),
          ...config.batch.spans,
        }),
      );
    }
    // A gate wraps the configured sampler, so nothing is sampled while it is closed (the summary
    // still names the configured sampler), and every span processor, so a span that ends after the
    // gate closed is dropped rather than buffered.
    const traceGate = platform.gate;
    const sampler =
      traceGate === undefined ? config.sampler.instance : gatedSampler(config.sampler.instance, traceGate);
    tracerProvider = new TracerProvider({
      resource,
      sampler,
      spanProcessors:
        traceGate === undefined
          ? spanProcessors
          : spanProcessors.map((p) => gatedSpanProcessor(p, traceGate)),
    });

    if (exporters.logExporter !== undefined || exporters.logProcessor !== undefined) {
      const processors: LogRecordProcessor[] = [new RedactingLogRecordProcessor(policy)];
      if (exporters.logProcessor !== undefined) processors.push(exporters.logProcessor);
      if (exporters.logExporter !== undefined) {
        processors.push(
          new BatchLogRecordProcessor({ exporter: exporters.logExporter, ...config.batch.logs }),
        );
      }
      const gate = platform.gate;
      loggerProvider = new LoggerProvider({
        resource,
        processors: gate === undefined ? processors : processors.map((p) => gatedLogRecordProcessor(p, gate)),
      });
    }
    const pipeline = new LogPipeline({
      level: config.logLevel,
      policy,
      ...(options.attrReplacer === undefined ? {} : { replacer: options.attrReplacer }),
      ...(config.console === "off"
        ? {}
        : { console: new ConsoleSink(config.console, (line) => platform.writeConsoleLine(line)) }),
      ...(loggerProvider === undefined ? {} : { otlp: loggerProvider.getLogger(CORE_SCOPE, VERSION) }),
      ...(platform.gate === undefined ? {} : { gate: platform.gate }),
    });
    const logger = new CoreLogger(pipeline);
    if (options.captureConsole === true && platform.console !== undefined) {
      restoreConsole = captureConsole(platform.console, logger);
    }

    const summary = buildSummary(config, resource, {
      versionFallback: built.versionFallback,
      propagatorFields: propagator.fields(),
      runtimeMetrics: runtime !== undefined,
    });
    return {
      config,
      platform,
      resource,
      pipeline,
      logger,
      sdkMeterProvider,
      meterProvider,
      tracerProvider,
      loggerProvider,
      propagator,
      exemplars,
      summaryAttributes: summary.attributes,
      effectiveConfig: summary.effectiveConfig,
      runtime,
      restoreConsole,
    };
  } catch (err) {
    restoreConsole?.();
    try {
      runtime?.stop();
    } catch {
      // Cleanup is best effort; the original error is the one to report.
    }
    await Promise.allSettled([
      sdkMeterProvider.shutdown(),
      tracerProvider?.shutdown() ?? Promise.resolve(),
      loggerProvider?.shutdown() ?? Promise.resolve(),
    ]);
    throw err;
  }
}

// deferCanary sends the canary's OTLP leg on the gate's first open, once, when a closed gate
// skipped it at setup. The console leg was written at setup, so the deferred record is OTLP only.
function deferCanary(handle: TelemetryHandle): void {
  const { parts } = handle;
  const gate = parts.platform.gate;
  if (gate === undefined || parts.loggerProvider === undefined || gate.recording()) return;
  let sent = false;
  const unsubscribe = gate.subscribe((recording) => {
    if (!recording || sent) return;
    sent = true;
    handle.stopDeferredCanary?.();
    handle.stopDeferredCanary = undefined;
    try {
      parts.pipeline.emit(
        "info",
        EVENT_TELEMETRY_CONFIGURED,
        eventAttributes(EVENT_TELEMETRY_CONFIGURED, parts.summaryAttributes),
        {
          ctx: forceEmit(ROOT_CONTEXT),
          otlpOnly: true,
        },
      );
    } catch {
      // Not strict: the deferred leg is best effort.
    }
  });
  handle.stopDeferredCanary = unsubscribe;
}

function takeGuard(): void {
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (g[GUARD] === true) throw alreadySetupError();
  g[GUARD] = true;
}

function releaseGuard(): void {
  const g = globalThis as unknown as Record<symbol, unknown>;
  delete g[GUARD];
}

/**
 * Builds a Telemetry and installs it globally (Go Setup). The guard on
 * globalThis[Symbol.for("libo11y.setup")], shared by every copy of core, makes a second call fail
 * with ALREADY_SETUP until the first shuts down. The startup canary runs before any global is
 * installed; a sink that rejects it fails setup with CANARY_REJECTED.
 */
export async function setupWith(options: TelemetryOptions, platform: Platform): Promise<Telemetry> {
  takeGuard();
  let handle: TelemetryHandle;
  try {
    handle = handleFor(await build(options, platform));
  } catch (err) {
    releaseGuard();
    throw err;
  }
  const { parts } = handle;
  if (parts.config.startupSummary) {
    try {
      emitEvent(parts.pipeline, EVENT_TELEMETRY_CONFIGURED, parts.summaryAttributes, ROOT_CONTEXT, {
        strict: true,
      });
    } catch (err) {
      await handle.shutdown();
      releaseGuard();
      throw canaryRejectedError(err);
    }
    deferCanary(handle);
  }

  const handler = rateLimitedErrorHandler(platform);
  const refused: string[] = [];
  const installed: Installed = {
    context: false,
    tracer: false,
    meter: false,
    logger: false,
    propagator: false,
  };
  try {
    const contextManager = platform.contextManager().enable();
    installed.context = context.setGlobalContextManager(contextManager);
    if (!installed.context) {
      contextManager.disable();
      refused.push("context manager");
    }
    installed.tracer = trace.setGlobalTracerProvider(parts.tracerProvider);
    if (!installed.tracer) refused.push("tracer provider");
    installed.meter = metrics.setGlobalMeterProvider(parts.meterProvider);
    if (!installed.meter) refused.push("meter provider");
    if (parts.loggerProvider !== undefined) {
      installed.logger = logs.setGlobalLoggerProvider(parts.loggerProvider);
      if (!installed.logger) refused.push("logger provider");
    }
    installed.propagator = propagation.setGlobalPropagator(parts.propagator);
    if (!installed.propagator) refused.push("propagator");
    setGlobalErrorHandler(handler);
  } catch (err) {
    // Leave nothing behind: what was installed is removed, the providers stop, the guard is free.
    try {
      uninstall(installed);
    } finally {
      await handle.shutdown();
      releaseGuard();
    }
    throw err;
  }
  handle.installed = installed;
  for (const what of refused) {
    handler(new Error(`o11y: another global ${what} is registered; libo11y's was not installed`));
  }
  return handle;
}
