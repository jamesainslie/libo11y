/**
 * The recorder: a hermetic libo11y telemetry over in-memory signals, as Go's o11ytest.Start builds.
 * It never installs a provider globally. The one global it may touch is the OpenTelemetry context
 * manager, which OTel JS keeps process-wide: without one no span is ever active, so the recorder
 * installs an AsyncLocalStorageContextManager when none is registered and leaves any existing one.
 */
import {
  createTelemetryWith,
  type Exemplar,
  exemplarsOf,
  type LogLevel,
  type ResourceMetricsWithExemplars,
  type Telemetry,
  type TelemetryOptions,
} from "@libo11y/core";
import { createTestPlatform, exemplarStoreOf } from "@libo11y/core/testing";
import {
  type Attributes,
  context,
  createContextKey,
  isSpanContextValid,
  ROOT_CONTEXT,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { type DataPoint, MetricReader, type ResourceMetrics } from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import {
  type CapturedLog,
  conformanceProblems,
  correlationProblems,
  fail,
  triangleProblems,
} from "./assertions.ts";

/** The options createRecorder takes: any TelemetryOptions except the signal plumbing it owns. */
export interface RecorderOptions
  extends Omit<
    TelemetryOptions,
    | "spanExporter"
    | "spanProcessor"
    | "metricReader"
    | "logExporter"
    | "logProcessor"
    | "logExport"
    | "hermetic"
  > {}

/** One log record as the OTLP leg emitted it, after classification. */
export interface RecordedLog {
  readonly body: string;
  readonly level: LogLevel;
  readonly severityNumber: number;
  /** The classified attributes. Groups are nested maps, as the OTLP leg carries them. */
  readonly attributes: Readonly<Record<string, unknown>>;
  /** Lowercase hex, present when the record was emitted inside a valid span context. */
  readonly traceId?: string;
  readonly spanId?: string;
  /** The event.name attribute, for records emitted as events. */
  readonly eventName?: string;
}

/** One exemplar in harness form. */
export interface RecordedExemplar {
  /** Lowercase hex, present when the measurement ran inside a valid span context. */
  readonly traceId?: string;
  readonly spanId?: string;
  readonly value: number;
  /** The measurement's attributes that the data point does not carry. */
  readonly filteredAttributes: Attributes;
}

/** The telemetry a recorder captured. */
export interface Recorder {
  /** The hermetic telemetry under the harness. Inject its providers or logger into the code under test. */
  readonly telemetry: Telemetry;
  /** Every span ended so far, in end order, already redacted. */
  spans(): readonly ReadableSpan[];
  /** Every log record the OTLP leg emitted so far, in emission order, already classified. */
  logs(): readonly RecordedLog[];
  /**
   * Collects every instrument through the manual reader, with exemplars attached. A collection
   * consumes the exemplar store's samples, so each point also keeps the exemplars earlier
   * collections attached to it. Rejects after shutdown.
   */
  metrics(): Promise<ResourceMetricsWithExemplars>;
  /** The names of every instrument with recorded data. */
  metricNames(): Promise<readonly string[]>;
  /** The exemplars on the named instrument, across all its data points. */
  exemplars(instrument: string): Promise<readonly RecordedExemplar[]>;
  /**
   * Throws AssertionError if the code under test broke the libo11y specification: a tier-0 resource
   * key missing, a secret-classified attribute counted on o11y.schema.violations or visible in a
   * log or span attribute, or a registered event lacking an attribute its contract requires. It
   * flushes first. Call it before shutdown: it collects metrics.
   */
  assertConforms(): Promise<void>;
  /**
   * Throws AssertionError unless every log recorded inside a span carries that span's trace ID.
   * Records emitted outside any span are ignored.
   */
  assertCorrelated(): void;
  /**
   * Throws AssertionError unless the correlation triangle closes: a recorded span, a log carrying
   * its trace and span IDs, and an exemplar on metric carrying the same trace ID.
   */
  assertTriangle(opts: { readonly metric: string }): Promise<void>;
  /** Shuts the telemetry down. Idempotent. What was recorded stays readable. */
  shutdown(): Promise<void>;
}

const PROBE: symbol = createContextKey("libo11y.test.context-probe");

/**
 * Installs an AsyncLocalStorageContextManager as the global context manager unless a working one is
 * already registered. The probe asks the active manager to carry a context through context.with.
 */
export function ensureContextManager(): void {
  const ctx = ROOT_CONTEXT.setValue(PROBE, true);
  if (context.with(ctx, () => context.active() === ctx)) return;
  const manager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(manager)) manager.disable();
}

/** A span exporter that keeps every span it is given, even after shutdown. */
class SpanRecording implements SpanExporter {
  readonly spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], resultCallback: (result: { code: number }) => void): void {
    this.spans.push(...spans);
    resultCallback({ code: 0 });
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

const LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

/** The level of an OTLP severity number: 1 to 4 is trace, 5 to 8 debug, and so on up to fatal. */
export function levelOf(severityNumber: number): LogLevel {
  const i = Math.floor((severityNumber - 1) / 4);
  return LEVELS[Math.min(Math.max(i, 0), LEVELS.length - 1)] as LogLevel;
}

/** A log record processor that snapshots each record, classified, as it is emitted. */
class LogRecording implements LogRecordProcessor {
  readonly logs: CapturedLog[] = [];

  /**
   * onEmit runs synchronously in the emitter's stack, so context.active() is the caller's real
   * active context, whatever context the emitter passed. That span is the reference
   * assertCorrelated checks the record's trace ID against: a record emitted with ROOT_CONTEXT or a
   * stale context while a span is active is caught.
   */
  onEmit(record: ReadWriteLogRecord): void {
    const severityNumber = record.severityNumber ?? 0;
    const attributes = { ...record.attributes } as Record<string, unknown>;
    const eventName = record.eventName ?? attributes["event.name"];
    const sc = record.spanContext;
    const log: RecordedLog = {
      body: typeof record.body === "string" ? record.body : String(record.body ?? ""),
      level: levelOf(severityNumber),
      severityNumber,
      attributes,
      ...(sc === undefined ? {} : { traceId: sc.traceId, spanId: sc.spanId }),
      ...(typeof eventName === "string" ? { eventName } : {}),
    };
    const active = trace.getSpanContext(context.active());
    this.logs.push({ log, active: active !== undefined && isSpanContextValid(active) ? active : undefined });
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

/** A metric reader whose collect the recorder calls on demand. */
class ManualReader extends MetricReader {
  protected override async onShutdown(): Promise<void> {}

  protected override async onForceFlush(): Promise<void> {}
}

const INJECTED: readonly string[] = [
  "spanExporter",
  "spanProcessor",
  "metricReader",
  "logExporter",
  "logProcessor",
  "logExport",
  "hermetic",
];

function seriesKey(scope: string, metric: string, attributes: Attributes): string {
  const attrs = Object.keys(attributes)
    .sort()
    .map((k) => [k, attributes[k]]);
  return JSON.stringify([scope, metric, attrs]);
}

function exemplarKey(e: Exemplar): string {
  return `${e.timeUnixNano}\u0000${e.traceId ?? ""}\u0000${e.spanId ?? ""}\u0000${e.value}`;
}

class RecorderImpl implements Recorder {
  readonly telemetry: Telemetry;
  private readonly spanRecording: SpanRecording;
  private readonly logRecording: LogRecording;
  private readonly reader: ManualReader;
  /** The exemplars each series has carried, so a collection does not lose what an earlier one attached. */
  private readonly seen = new Map<string, Exemplar[]>();
  private closing: Promise<void> | undefined;

  constructor(telemetry: Telemetry, spans: SpanRecording, logs: LogRecording, reader: ManualReader) {
    this.telemetry = telemetry;
    this.spanRecording = spans;
    this.logRecording = logs;
    this.reader = reader;
  }

  spans(): readonly ReadableSpan[] {
    return [...this.spanRecording.spans];
  }

  logs(): readonly RecordedLog[] {
    return this.logRecording.logs.map((c) => c.log);
  }

  async metrics(): Promise<ResourceMetricsWithExemplars> {
    let collected: { resourceMetrics: ResourceMetrics; errors: unknown[] };
    try {
      collected = await this.reader.collect();
    } catch (err) {
      throw new Error(`o11ytest: collecting metrics: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    if (collected.errors.length > 0) {
      throw new Error(`o11ytest: collecting metrics: ${collected.errors.map(String).join("; ")}`, {
        cause: collected.errors[0],
      });
    }
    return this.remember(exemplarStoreOf(this.telemetry).attach(collected.resourceMetrics));
  }

  // remember merges each point's newly attached exemplars with those its series carried before.
  private remember(rm: ResourceMetricsWithExemplars): ResourceMetricsWithExemplars {
    const scopeMetrics = rm.scopeMetrics.map((sm) => {
      const scope = `${sm.scope.name}\u0000${sm.scope.version ?? ""}`;
      const metrics = sm.metrics.map((metric) => {
        const dataPoints = (metric.dataPoints as DataPoint<unknown>[]).map((point) => {
          const key = seriesKey(scope, metric.descriptor.name, point.attributes);
          const known = this.seen.get(key) ?? [];
          const keys = new Set(known.map(exemplarKey));
          const merged = [...known, ...exemplarsOf(point).filter((e) => !keys.has(exemplarKey(e)))];
          if (merged.length === 0) return point;
          this.seen.set(key, merged);
          return { ...point, exemplars: merged };
        });
        return { ...metric, dataPoints } as typeof metric;
      });
      return { ...sm, metrics };
    });
    return { ...rm, scopeMetrics };
  }

  async metricNames(): Promise<readonly string[]> {
    const rm = await this.metrics();
    return rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.descriptor.name));
  }

  async exemplars(instrument: string): Promise<readonly RecordedExemplar[]> {
    const rm = await this.metrics();
    const out: RecordedExemplar[] = [];
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        if (metric.descriptor.name !== instrument) continue;
        for (const point of metric.dataPoints as DataPoint<unknown>[]) {
          for (const e of exemplarsOf(point)) {
            out.push({
              ...(e.traceId === undefined ? {} : { traceId: e.traceId }),
              ...(e.spanId === undefined ? {} : { spanId: e.spanId }),
              value: e.value,
              filteredAttributes: e.filteredAttributes,
            });
          }
        }
      }
    }
    return out;
  }

  async assertConforms(): Promise<void> {
    const preflight: string[] = [];
    const flushed = await this.telemetry.forceFlush();
    for (const { error } of flushed.errors) {
      preflight.push(`o11ytest: flushing before conformance checks: ${String(error)}`);
    }
    let metrics: ResourceMetricsWithExemplars | undefined;
    try {
      metrics = await this.metrics();
    } catch (err) {
      preflight.push(err instanceof Error ? err.message : String(err));
    }
    const problems = conformanceProblems({
      resource: this.telemetry.resource.attributes,
      preflight,
      ...(metrics === undefined ? {} : { metrics }),
      logs: this.logs(),
      spans: this.spans(),
    });
    if (problems.length > 0) fail(problems);
  }

  assertCorrelated(): void {
    const problems = correlationProblems(this.logRecording.logs);
    if (problems.length > 0) fail(problems);
  }

  async assertTriangle(opts: { readonly metric: string }): Promise<void> {
    const problems = triangleProblems(
      opts.metric,
      this.spans(),
      this.logs(),
      await this.exemplars(opts.metric),
    );
    if (problems.length > 0) fail(problems);
  }

  shutdown(): Promise<void> {
    this.closing ??= this.telemetry.shutdown().then((report) => {
      if (report.ok) return;
      const detail = report.errors.map(({ signal, error }) => `${signal}: ${String(error)}`).join("; ");
      throw new Error(`o11ytest: shutdown: ${detail}`);
    });
    return this.closing;
  }
}

/**
 * Builds a hermetic telemetry that records every signal in memory (Go o11ytest.Start). Defaults:
 * service name "test", environment "test", debug level, no console, no runtime metrics, no startup
 * summary, every span sampled and trace-based exemplars. OTEL_* variables have no effect. Caller
 * options win over the defaults, except the injected span, metric and log plumbing.
 */
export async function createRecorder(options: RecorderOptions = {}): Promise<Recorder> {
  ensureContextManager();
  const spans = new SpanRecording();
  const logs = new LogRecording();
  const reader = new ManualReader();
  const caller: Record<string, unknown> = { ...options };
  for (const key of INJECTED) delete caller[key];
  const telemetry = await createTelemetryWith(
    {
      serviceName: "test",
      environment: "test",
      logLevel: "debug",
      console: false,
      runtimeMetrics: false,
      startupSummary: false,
      sampler: new AlwaysOnSampler(),
      exemplarFilter: "trace_based",
      ...(caller as TelemetryOptions),
      hermetic: true,
      spanProcessor: new SimpleSpanProcessor({ exporter: spans }),
      metricReader: reader,
      logProcessor: logs,
    },
    createTestPlatform({ contextManager: () => new AsyncLocalStorageContextManager() }),
  );
  return new RecorderImpl(telemetry, spans, logs, reader);
}
