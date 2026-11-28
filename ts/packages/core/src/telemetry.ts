/**
 * The lifecycle. createTelemetryWith builds the providers, the logger and the summary without
 * touching any global, as Go's New does. setupWith takes the process-wide guard, builds, emits the
 * o11y.telemetry.configured canary through the strict path, and only then installs the globals:
 * the context manager, tracer, meter, logger and propagator providers, then the error handler.
 *
 * shutdown stops logs, metrics and traces concurrently under one deadline, so a hung exporter on
 * one signal cannot spend the others' budget. Every caller gets the same promise, which never
 * rejects. forceFlush runs the signals in turn under the same deadline handling.
 *
 * Each signal's exporter is watched (export-watch.ts). A signal is reported as failed when its
 * provider says so, when the deadline passes, or when an export failed while it flushed, which the
 * upstream log processor and metric reader keep to themselves. When shutdown has settled, the
 * exports still in flight are failed and their exporters stopped, so nothing the telemetry started
 * keeps the process alive.
 *
 * An export that fails outside any flush or shutdown, as one the batch timer or the periodic reader
 * starts does, is said with o11y.telemetry.dropped, as shutdown says its losses. Upstream hands it
 * to the global error handler only, which a telemetry from createTelemetryWith never installs.
 */
import { EVENT_TELEMETRY_CONFIGURED, EVENT_TELEMETRY_DROPPED } from "@libo11y/spec";
import {
  type LoggerProvider as ApiLoggerProvider,
  type TracerProvider as ApiTracerProvider,
  type Context,
  context,
  createNoopLogger,
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
import { type ResolvedConfig, resolveConfig, validateOptions } from "./config.ts";
import { captureConsole } from "./console-capture.ts";
import { ConsoleSink, formatTextLine } from "./console-sink.ts";
import { alreadySetupError, canaryRejectedError, piiHashKeyError } from "./errors.ts";
import { emitEvent, eventAttributes } from "./events.ts";
import { ExemplarStore } from "./exemplars.ts";
import { ExportWatch } from "./export-watch.ts";
import { gatedLogRecordProcessor, gatedSampler, gatedSpanProcessor } from "./gate.ts";
import { buildResource } from "./identity.ts";
import { errorClass, REPORT_KEY } from "./internal/report.ts";
import { seams } from "./internal/seams.ts";
import { registerExemplarStore } from "./internal/stores.ts";
import { after, MAX_TIMEOUT_MILLIS } from "./internal/timers.ts";
import { registerMetricWatch } from "./internal/watches.ts";
import type { LogAttributes } from "./log-values.ts";
import { CoreLogger, forceEmit, type Logger, LogPipeline } from "./logger.ts";
import { CoalescingLogRecordProcessor, RedactingLogRecordProcessor } from "./logs-processor.ts";
import { PolicyMeterProvider } from "./metrics.ts";
import type { TelemetryOptions } from "./options.ts";
import type { ExporterSet, Platform, RuntimeMetrics } from "./platform.ts";
import { compileRegistries, MIN_PII_HASH_KEY_LENGTH, SensitivityPolicy } from "./policy.ts";
import { BaggageEgressPropagator, resolvePropagator } from "./propagation.ts";
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
  /**
   * The deadline for all signals together, in milliseconds. Default 5000. A negative value is 0 and
   * anything past 2147483647 is that. A string that reads as a finite number is taken as that
   * number, and any other value that is not a number is the default.
   */
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

// clampTimeout reads a caller's deadline. A number is bounded to what a timer can wait: negative is
// 0, and Infinity or anything past the timer maximum is the maximum. A string that reads as a
// finite number is that number, as it always was. NaN, any other string and any other value are
// the default: a timer armed with NaN fires after a millisecond.
function clampTimeout(given: unknown): number {
  const ms = typeof given === "string" && given.trim() !== "" ? Number(given) : given;
  if (typeof ms !== "number" || Number.isNaN(ms)) return DEFAULT_TIMEOUT_MILLIS;
  return Math.min(Math.max(ms, 0), MAX_TIMEOUT_MILLIS);
}
const GUARD: unique symbol = Symbol.for("libo11y.setup") as never;

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
  return { expired, cancel: after(ms, () => fire()) };
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

// A rate-limited error handler: Go's, a token bucket of 5 refilled one per 30 s, writing slog text
// lines to the diagnostic stream, outside the pipeline so a failing exporter cannot recurse. Each
// call makes a bucket of its own. A telemetry has three: one for what the SDK and the exporters
// report, which setupWith installs as the global error handler, one for what the logger drops, and
// one for what the instrumentation built on core reports. A getter that fails on every request
// then cannot use up the lines an exporter failure needs.
function rateLimitedErrorHandler(platform: Platform): (err: unknown) => void {
  const write = rateLimitedDiagnostics(platform);
  return (err) => {
    if (err === undefined || err === null) return;
    write("o11y: telemetry error", { error: causeText(err) });
  };
}

// rateLimitedDiagnostics writes warn lines to the diagnostic stream through a token bucket of its
// own. A line written after some were held back says how many.
function rateLimitedDiagnostics(platform: Platform): (msg: string, attributes: LogAttributes) => void {
  const take = tokenBucket(Date.now);
  return (msg, attrs) => {
    const held = take();
    if (held !== undefined) writeDiagnostic(platform, msg, held > 0 ? { ...attrs, suppressed: held } : attrs);
  };
}

// tokenBucket is the limit every rate-limited report here shares, Go's: 5, refilled one per 30 s.
// A call returns undefined while the bucket is empty, and otherwise how many calls it held back
// since the last one that passed.
function tokenBucket(now: () => number): () => number | undefined {
  const burst = 5;
  const refillMillis = 30_000;
  let tokens = burst;
  let last = now();
  let suppressed = 0;
  return () => {
    const at = now();
    tokens = Math.min(burst, tokens + (at - last) / refillMillis);
    last = at;
    if (tokens < 1) {
      suppressed++;
      return undefined;
    }
    tokens--;
    const held = suppressed;
    suppressed = 0;
    return held;
  };
}

function writeDiagnostic(platform: Platform, msg: string, attributes: LogAttributes): void {
  try {
    platform.writeDiagnosticLine(formatTextLine({ time: new Date(), level: "warn", msg, attributes }));
  } catch {
    // The diagnostic stream is the last resort; nothing is left to report to.
  }
}

// droppedAttributes are o11y.telemetry.dropped's: the signal and the class of what failed, never
// its message, which can quote an endpoint or a header.
function droppedAttributes(signal: Signal, errorType: string): LogAttributes {
  return { "o11y.signal": signal, "error.type": errorType };
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
  /** The rate-limited handler for the SDK and the exporters: the global one once setupWith installs it. */
  readonly errorHandler: (err: unknown) => void;
  /** The rate-limited handler for instrumentation built on core, which the handle carries under REPORT_KEY. */
  readonly instrumentationErrorHandler: (err: unknown) => void;
  /** The watch over each signal's exporter. */
  readonly watches: Readonly<Record<Signal, ExportWatch>>;
  /** Says a signal was dropped: to the console sink, or to the diagnostic stream when it is off. */
  readonly sayDropped: (signal: Signal, errorType: string) => void;
}

/** One signal's part in a flush or a shutdown. */
interface Step {
  readonly signal: Signal;
  readonly watch: ExportWatch;
  shutdown(): Promise<void>;
  flush(): Promise<void>;
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
  readonly [REPORT_KEY]: (err: unknown) => void;
  installed: Installed | undefined;
  /** Stops waiting for the gate's first open, while the canary's OTLP leg is deferred. */
  stopDeferredCanary: (() => void) | undefined;
  private shutdownPromise: Promise<SignalReport> | undefined;

  constructor(parts: Parts) {
    this.parts = parts;
    this[REPORT_KEY] = parts.instrumentationErrorHandler;
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

  private steps(): Step[] {
    const { loggerProvider: lp, sdkMeterProvider: mp, tracerProvider: tp, watches } = this.parts;
    // A flush also waits for the exports the batch timer had started, which the provider does not.
    // It waits for those in flight when the signal's turn comes and no others, so the exports of a
    // flush that begins later never hold this one back. A log flush that overlaps another shares
    // one follow-up flush (CoalescingLogRecordProcessor), so it resolves with its own records sent.
    const step = (
      signal: Signal,
      provider: { shutdown(): Promise<void>; forceFlush(): Promise<void> },
    ): Step => {
      const watch = watches[signal];
      return {
        signal,
        watch,
        shutdown: () => provider.shutdown(),
        flush: async () => {
          const inFlight = watch.inFlight();
          await provider.forceFlush();
          await inFlight;
        },
      };
    };
    const steps: Step[] = [];
    if (lp !== undefined) steps.push(step("logs", lp));
    steps.push(step("metrics", mp), step("traces", tp));
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
    const steps = this.steps();
    // Every signal is observed from the start: the signals flush in turn, and an export already in
    // flight can fail while an earlier signal is still flushing.
    const seen = steps.map((s) => s.watch.observe());
    try {
      for (const [i, step] of steps.entries()) {
        // The provider's own failure first, else an export that failed since the flush began.
        const outcome = (await settle(step.flush, timer.expired)) ?? seen[i]?.failure()?.error;
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
      for (const observation of seen) observation.end();
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
    const watches = Object.values(this.parts.watches);
    const seen = steps.map((s) => s.watch.observe());
    let outcomes: unknown[];
    try {
      outcomes = await Promise.all(steps.map((s) => settle(s.shutdown, timer.expired)));
      // A provider can settle with exports still in flight. Upstream's span processor sends its
      // batches together and rejects at the first that fails, and an injected processor can reject
      // at once. The others get the rest of the deadline, still observed, before anything is stopped.
      await Promise.race([Promise.all(watches.map((w) => w.idle())), timer.expired]);
      // A provider that resolved may still have lost its last export: upstream's log processor and
      // metric reader report that to the error handler only.
      outcomes = outcomes.map((outcome, i) => outcome ?? seen[i]?.failure()?.error);
    } finally {
      timer.cancel();
      for (const observation of seen) observation.end();
      // Whatever is still exporting has had its time. Failing it clears the processors' export
      // timers, and stopping the exporters lets them drop what they hold, so nothing here keeps
      // the process alive once shutdown has resolved.
      for (const watch of watches) {
        try {
          watch.close();
        } catch {
          // Stopping an exporter is best effort.
        }
      }
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
    // The OTLP leg is down, so the loss reaches the console sink, or the diagnostic stream when the
    // console sink is off. Never rate limited: it is the last word on each signal.
    for (const { signal, error } of errors) {
      try {
        this.parts.sayDropped(signal, error instanceof Error ? error.constructor.name : typeof error);
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
  // Before anything is built: a value outside an option's set fails here, typed, not later in
  // silence, and so does a PII hash key that is not a Uint8Array, in every PII mode.
  validateOptions(options);
  const pii = options.piiMode ?? "drop";
  // Null is "not given", as for the other options. validateOptions has shown the key is bytes.
  const key = options.piiHashKey ?? undefined;
  if (pii === "hash" && (key === undefined || key.length < MIN_PII_HASH_KEY_LENGTH)) throw piiHashKeyError();
  let policy = SensitivityPolicy.create({
    pii,
    registries: compileRegistries(options.registry),
    ...(key === undefined ? {} : { key }),
    ...(platform.hmacSha256 === undefined ? {} : { hmac: platform.hmacSha256.bind(platform) }),
  });

  // Hermetic mode reads no OTEL_* variable at all.
  const env = options.hermetic === true ? {} : platform.env();
  const config = resolveConfig(options, env);
  // Null is "not given", as for the other options.
  const selected = resolvePropagator(options.propagators ?? undefined, env.OTEL_PROPAGATORS);
  const layers = await platform.detectResource(config.hermetic);
  const built = await buildResource(options, layers, policy, platform);
  const resource = built.resource;

  const propagator = new BaggageEgressPropagator(selected.propagator, seams.baggageEgress ?? (() => true));

  // With metrics off nothing can read the store, so it samples nothing.
  const exemplars = new ExemplarStore({
    filter: config.metrics === "none" || config.sdkDisabled ? "always_off" : config.exemplarFilter,
  });
  // An export that fails while no flush or shutdown observes its watch is said here, once the log
  // pipeline exists: o11y.telemetry.dropped to the console sink, as shutdown says it, or to the
  // diagnostic stream when the console sink is off. Never to the OTLP leg, so a failing log export
  // cannot feed itself.
  let dropped: ((signal: Signal, error: unknown) => void) | undefined;
  const watchFor = (signal: Signal, timeoutMillis: number): ExportWatch =>
    new ExportWatch(timeoutMillis, (error) => dropped?.(signal, error));
  const watches: Record<Signal, ExportWatch> = {
    traces: watchFor("traces", config.batch.spans.exportTimeoutMillis),
    metrics: watchFor(
      "metrics",
      Math.min(config.metricExport.timeoutMillis, config.metricExport.intervalMillis),
    ),
    logs: watchFor("logs", config.batch.logs.exportTimeoutMillis),
  };
  // A platform's metric reader holds its own exporter. exemplarMetricExporter puts the watch on it.
  registerMetricWatch(exemplars, watches.metrics);
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
  // One handler for everything instruments and instrumentation report: the handle carries it.
  const instrumentationErrorHandler = rateLimitedErrorHandler(platform);
  const meterProvider = new PolicyMeterProvider(
    sdkMeterProvider,
    policy,
    exemplars,
    instrumentationErrorHandler,
    platform.gate,
  );

  const errorHandler = rateLimitedErrorHandler(platform);
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
          exporter: watches.traces.watch(redactingSpanExporter(exporters.spanExporter, policy)),
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
      // A flush never overlaps another on a processor that exports, and its shutdown never
      // overlaps a flush: upstream's batch processor skips a flush that does, and loses records.
      if (exporters.logProcessor !== undefined) {
        processors.push(new CoalescingLogRecordProcessor(exporters.logProcessor));
      }
      if (exporters.logExporter !== undefined) {
        processors.push(
          new CoalescingLogRecordProcessor(
            new BatchLogRecordProcessor({
              exporter: watches.logs.watch(exporters.logExporter),
              ...config.batch.logs,
            }),
          ),
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
      onError: rateLimitedErrorHandler(platform),
      ...(options.attrReplacer === undefined ? {} : { replacer: options.attrReplacer }),
      ...(config.console === "off"
        ? {}
        : { console: new ConsoleSink(config.console, (line) => platform.writeConsoleLine(line)) }),
      ...(loggerProvider === undefined ? {} : { otlp: loggerProvider.getLogger(CORE_SCOPE, VERSION) }),
      ...(platform.gate === undefined ? {} : { gate: platform.gate }),
    });
    const logger = new CoreLogger(pipeline);
    const sayDropped = (signal: Signal, errorType: string, held = 0): void => {
      const attrs = droppedAttributes(signal, errorType);
      if (config.console !== "off")
        emitEvent(pipeline, EVENT_TELEMETRY_DROPPED, attrs, ROOT_CONTEXT, { consoleOnly: true });
      else {
        const line = eventAttributes(EVENT_TELEMETRY_DROPPED, attrs);
        writeDiagnostic(platform, EVENT_TELEMETRY_DROPPED, held > 0 ? { ...line, suppressed: held } : line);
      }
    };
    // While a collector stays down, every export interval fails again. Each signal says so 5
    // times, then once every 30 s. A diagnostic line says how many it held back.
    const now = seams.now ?? Date.now;
    const limits: Record<Signal, () => number | undefined> = {
      traces: tokenBucket(now),
      metrics: tokenBucket(now),
      logs: tokenBucket(now),
    };
    dropped = (signal, error) => {
      const held = limits[signal]();
      if (held !== undefined) sayDropped(signal, errorClass(error), held);
    };
    if (options.captureConsole === true && platform.console !== undefined) {
      restoreConsole = captureConsole(platform.console, logger);
    }

    const summary = buildSummary(config, resource, {
      versionFallback: built.versionFallback,
      propagatorFields: selected.fields,
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
      errorHandler,
      instrumentationErrorHandler,
      watches,
      sayDropped,
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

  const handler = parts.errorHandler;
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
