/** The exporters over a fake Delivery, and the ExporterSet routes. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ExemplarStore, O11yError, type ResolvedConfig } from "@libo11y/core";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ConsoleLogRecordExporter,
  InMemoryLogRecordExporter,
  LoggerProvider,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InstrumentType,
  MeterProvider,
  MetricReader,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
  ConsoleSpanExporter,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import type { OtlpBatch } from "../contracts/otlp.ts";
import type { Delivery, DeliveryResult, SendMode } from "../contracts/transport.ts";
import type { SignalEndpoints } from "./endpoints.ts";
import {
  createExporterSet,
  createLogExporter,
  createMetricExporter,
  createSpanExporter,
} from "./exporters.ts";
import { UNLOAD_BODY_LIMIT } from "./http.ts";

interface FakeDelivery extends Delivery {
  readonly batches: OtlpBatch[];
  script(...results: DeliveryResult[]): void;
  /** Holds every deliver until release. */
  hold(): () => void;
}

function fakeDelivery(): FakeDelivery {
  const batches: OtlpBatch[] = [];
  const script: DeliveryResult[] = [];
  let gate: Promise<void> | undefined;
  return {
    batches,
    script: (...r) => {
      script.push(...r);
    },
    hold() {
      let release: () => void = () => {};
      gate = new Promise<void>((r) => (release = r));
      return () => {
        release();
        gate = undefined;
      };
    },
    async deliver(batch) {
      batches.push(batch);
      const result = script.shift() ?? { outcome: "sent" };
      if (gate !== undefined) await gate;
      return result;
    },
    drain: async () => {},
    clear: async () => {},
    shutdown: async () => ({ timedOut: [] }),
  };
}

const resource = resourceFromAttributes({ "service.name": "shop" });

async function spans(n: number, attrBytes = 10): Promise<ReadableSpan[]> {
  const exporter = new InMemorySpanExporter();
  const tp = new TracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  for (let i = 0; i < n; i++) {
    tp.getTracer("t")
      .startSpan(`s${i}`, { attributes: { pad: "x".repeat(attrBytes) } })
      .end();
  }
  await tp.forceFlush();
  const out = exporter.getFinishedSpans();
  await tp.shutdown();
  return out;
}

async function logs(n: number, bodyBytes = 10): Promise<ReadableLogRecord[]> {
  const exporter = new InMemoryLogRecordExporter();
  const lp = new LoggerProvider({ resource, processors: [new SimpleLogRecordProcessor({ exporter })] });
  for (let i = 0; i < n; i++) lp.getLogger("l").emit({ body: `${i}:${"y".repeat(bodyBytes)}` });
  await lp.forceFlush();
  const out = exporter.getFinishedLogRecords();
  await lp.shutdown();
  return out;
}

function exportWith<T>(
  exporter: { export(items: T, cb: (r: ExportResult) => void): void },
  items: T,
): Promise<ExportResult> {
  return new Promise((resolve) => exporter.export(items, resolve));
}

const bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

test("a span export delivers one traces batch of OTLP JSON", async () => {
  const d = fakeDelivery();
  const got = await exportWith(createSpanExporter(d), await spans(3));
  assert.equal(got.code, ExportResultCode.SUCCESS);
  assert.equal(d.batches.length, 1);
  assert.equal(d.batches[0]?.signal, "traces");
  const json = JSON.parse(d.batches[0]?.body ?? "{}") as {
    resourceSpans: { scopeSpans: { spans: unknown[] }[] }[];
  };
  assert.equal(json.resourceSpans[0]?.scopeSpans[0]?.spans.length, 3);
});

test("sent, queued and a gate drop are SUCCESS; any other drop is FAILED with its error", async () => {
  const d = fakeDelivery();
  const error = new Error("HTTP 400");
  d.script({ outcome: "sent" }, { outcome: "queued" }, { outcome: "dropped" }, { outcome: "dropped", error });
  const exporter = createSpanExporter(d);
  const items = await spans(1);
  assert.equal((await exportWith(exporter, items)).code, ExportResultCode.SUCCESS);
  assert.equal((await exportWith(exporter, items)).code, ExportResultCode.SUCCESS);
  assert.equal((await exportWith(exporter, items)).code, ExportResultCode.SUCCESS);
  const failed = await exportWith(exporter, items);
  assert.equal(failed.code, ExportResultCode.FAILED);
  assert.equal(failed.error, error);
});

test("the log exporter delivers logs batches and maps results the same way", async () => {
  const d = fakeDelivery();
  const error = new Error("refused");
  d.script({ outcome: "queued" }, { outcome: "dropped", error });
  const exporter = createLogExporter(d);
  const items = await logs(2);
  assert.equal((await exportWith(exporter, items)).code, ExportResultCode.SUCCESS);
  assert.equal(d.batches[0]?.signal, "logs");
  assert.match(d.batches[0]?.body ?? "", /"resourceLogs"/);
  const failed = await exportWith(exporter, items);
  assert.equal(failed.code, ExportResultCode.FAILED);
  assert.equal(failed.error, error);
});

test("in unload mode an export is split by halving until each body fits the limit", async () => {
  const d = fakeDelivery();
  let mode: SendMode = "normal";
  const exporter = createSpanExporter(d, { mode: () => mode });
  // Eight spans of about 20 KiB each: halved twice, two per part.
  const items = await spans(8, 20_000);
  await exportWith(exporter, items);
  assert.equal(d.batches.length, 1, "normal mode never splits");
  mode = "unload";
  assert.equal((await exportWith(exporter, items)).code, ExportResultCode.SUCCESS);
  const parts = d.batches.slice(1);
  assert.equal(parts.length, 4);
  for (const p of parts) assert.ok(bytes(p.body) <= UNLOAD_BODY_LIMIT);
  const names = parts.flatMap((p) =>
    (JSON.parse(p.body) as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] }).resourceSpans
      .flatMap((r) => r.scopeSpans)
      .flatMap((s) => s.spans)
      .map((s) => s.name),
  );
  assert.deepEqual(names, ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
});

test("a single item larger than the limit is delivered alone", async () => {
  const d = fakeDelivery();
  const exporter = createLogExporter(d, { mode: () => "unload" });
  const big = await logs(1, UNLOAD_BODY_LIMIT + 10);
  const small = await logs(1, 10);
  await exportWith(exporter, [...big, ...small]);
  assert.equal(d.batches.length, 2);
  assert.ok(bytes(d.batches[0]?.body ?? "") > UNLOAD_BODY_LIMIT);
  assert.ok(bytes(d.batches[1]?.body ?? "") <= UNLOAD_BODY_LIMIT);
});

test("a split export fails when any part fails", async () => {
  const d = fakeDelivery();
  const error = new Error("fatal");
  d.script({ outcome: "sent" }, { outcome: "dropped", error });
  const exporter = createSpanExporter(d, { mode: () => "unload" });
  const got = await exportWith(exporter, await spans(4, 20_000));
  assert.equal(got.code, ExportResultCode.FAILED);
  assert.equal(got.error, error);
});

test("forceFlush waits for every pending delivery", async () => {
  const d = fakeDelivery();
  const release = d.hold();
  const exporter = createSpanExporter(d);
  let done = false;
  exporter.export(await spans(1), () => {
    done = true;
  });
  let flushed = false;
  const flushing = exporter.forceFlush?.().then(() => {
    flushed = true;
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(flushed, false);
  release();
  await flushing;
  assert.equal(done, true);
  assert.equal(flushed, true);
});

test("shutdown waits for pending deliveries and refuses later exports", async () => {
  const d = fakeDelivery();
  const release = d.hold();
  const exporter = createLogExporter(d);
  const first = exportWith(exporter, await logs(1));
  const shutting = exporter.shutdown();
  release();
  await shutting;
  assert.equal((await first).code, ExportResultCode.SUCCESS);
  const later = await exportWith(exporter, await logs(1));
  assert.equal(later.code, ExportResultCode.FAILED);
  assert.equal(d.batches.length, 1);
});

class TestReader extends MetricReader {
  protected override async onShutdown(): Promise<void> {}
  protected override async onForceFlush(): Promise<void> {}
}

async function metrics(): Promise<ResourceMetrics> {
  const reader = new TestReader();
  const mp = new MeterProvider({ resource, readers: [reader] });
  mp.getMeter("m").createCounter("app.jobs").add(3);
  const { resourceMetrics } = await reader.collect();
  await mp.shutdown();
  return resourceMetrics;
}

test("the metric exporter delivers a metrics batch, is cumulative, and never splits", async () => {
  const d = fakeDelivery();
  const exporter = createMetricExporter(d);
  assert.equal(
    exporter.selectAggregationTemporality?.(InstrumentType.COUNTER),
    AggregationTemporality.CUMULATIVE,
  );
  assert.equal(
    exporter.selectAggregationTemporality?.(InstrumentType.HISTOGRAM),
    AggregationTemporality.CUMULATIVE,
  );
  assert.equal((await exportWith(exporter, await metrics())).code, ExportResultCode.SUCCESS);
  assert.equal(d.batches[0]?.signal, "metrics");
  assert.match(d.batches[0]?.body ?? "", /"app.jobs"/);
  const error = new Error("x");
  d.script({ outcome: "dropped", error });
  assert.equal((await exportWith(exporter, await metrics())).code, ExportResultCode.FAILED);
  await exporter.forceFlush();
  await exporter.shutdown();
  assert.equal((await exportWith(exporter, await metrics())).code, ExportResultCode.FAILED);
});

test("the metric exporter selects delta temporality for every instrument when asked", () => {
  const exporter = createMetricExporter(fakeDelivery(), "delta");
  for (const t of Object.values(InstrumentType)) {
    assert.equal(exporter.selectAggregationTemporality?.(t), AggregationTemporality.DELTA, t);
  }
});

const BATCH = {
  scheduledDelayMillis: 5000,
  exportTimeoutMillis: 5000,
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
};

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    hermetic: false,
    sdkDisabled: false,
    traces: "otlp",
    metrics: "otlp",
    logs: "otlp",
    protocol: { traces: "http/json", metrics: "http/json", logs: "http/json" },
    endpoints: {
      endpoint: undefined,
      traces_endpoint: undefined,
      metrics_endpoint: undefined,
      logs_endpoint: undefined,
    },
    sampler: { name: "always_on", instance: new AlwaysOnSampler() },
    exemplarFilter: "trace_based",
    logLevel: "info",
    console: "off",
    batch: { spans: BATCH, logs: BATCH },
    metricExport: { intervalMillis: 60000, timeoutMillis: 5000 },
    runtimeMetrics: false,
    startupSummary: false,
    ...overrides,
  };
}

const ALL: SignalEndpoints = {
  traces: "https://o.example.com/v1/traces",
  metrics: "https://o.example.com/v1/metrics",
  logs: "https://o.example.com/v1/logs",
};
const NONE: SignalEndpoints = { traces: undefined, metrics: undefined, logs: undefined };

const exemplars = (): ExemplarStore => new ExemplarStore({ filter: "trace_based" });

async function shutdownAll(set: ReturnType<typeof createExporterSet>): Promise<void> {
  await Promise.all([
    set.spanExporter?.shutdown(),
    set.metricReader?.shutdown(),
    set.logExporter?.shutdown(),
  ]);
}

test("otlp routes with endpoints build exporters over the delivery and a periodic reader", async () => {
  const d = fakeDelivery();
  const set = createExporterSet({ config: config(), exemplars: exemplars() }, d, ALL);
  try {
    assert.ok(set.spanExporter);
    assert.ok(set.logExporter);
    assert.ok(set.metricReader instanceof PeriodicExportingMetricReader);
    assert.equal((await exportWith(set.spanExporter, await spans(1))).code, ExportResultCode.SUCCESS);
    assert.equal(d.batches[0]?.signal, "traces");
    assert.equal((await exportWith(set.logExporter, await logs(1))).code, ExportResultCode.SUCCESS);
    assert.equal(d.batches[1]?.signal, "logs");
  } finally {
    await shutdownAll(set);
  }
});

test("the metric reader exports through the delivery", async () => {
  const d = fakeDelivery();
  const set = createExporterSet(
    { config: config({ traces: "none", logs: "none" }), exemplars: exemplars() },
    d,
    ALL,
  );
  const reader = set.metricReader;
  assert.ok(reader);
  const mp = new MeterProvider({ resource, readers: [reader] });
  mp.getMeter("m").createCounter("app.clicks").add(1);
  await mp.forceFlush();
  assert.equal(d.batches.at(-1)?.signal, "metrics");
  assert.match(d.batches.at(-1)?.body ?? "", /"app.clicks"/);
  await mp.shutdown();
});

test("metricTemporality delta makes the metric reader export delta sums", async () => {
  const d = fakeDelivery();
  const set = createExporterSet(
    { config: config({ traces: "none", logs: "none" }), exemplars: exemplars() },
    d,
    ALL,
    { metricTemporality: "delta" },
  );
  const reader = set.metricReader;
  assert.ok(reader);
  const mp = new MeterProvider({ resource, readers: [reader] });
  mp.getMeter("m").createCounter("app.clicks").add(1);
  mp.getMeter("m").createHistogram("app.wait").record(2);
  await mp.forceFlush();
  const body = JSON.parse(d.batches.at(-1)?.body ?? "{}") as {
    resourceMetrics: {
      scopeMetrics: {
        metrics: {
          sum?: { aggregationTemporality: number };
          histogram?: { aggregationTemporality: number };
        }[];
      }[];
    }[];
  };
  const ms = body.resourceMetrics.flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics));
  assert.deepEqual(
    ms.map((m) => (m.sum ?? m.histogram)?.aggregationTemporality),
    [1, 1],
  );
  await mp.shutdown();
});

test("the export options reach the span and log exporters", async () => {
  const d = fakeDelivery();
  const set = createExporterSet({ config: config({ metrics: "none" }), exemplars: exemplars() }, d, ALL, {
    mode: () => "unload",
  });
  try {
    assert.ok(set.spanExporter);
    await exportWith(set.spanExporter, await spans(8, 20_000));
    assert.equal(d.batches.length, 4);
  } finally {
    await shutdownAll(set);
  }
});

test("an otlp route without an endpoint builds nothing", () => {
  const set = createExporterSet({ config: config(), exemplars: exemplars() }, fakeDelivery(), NONE);
  assert.deepEqual(set, {});
  const partial = createExporterSet({ config: config(), exemplars: exemplars() }, fakeDelivery(), {
    ...NONE,
    logs: ALL.logs,
  });
  assert.deepEqual(Object.keys(partial), ["logExporter"]);
});

test("console routes build upstream's console exporters", async () => {
  const set = createExporterSet(
    { config: config({ traces: "console", metrics: "console", logs: "console" }), exemplars: exemplars() },
    fakeDelivery(),
    NONE,
  );
  try {
    assert.ok(set.spanExporter instanceof ConsoleSpanExporter);
    assert.ok(set.logExporter instanceof ConsoleLogRecordExporter);
    assert.ok(set.metricReader instanceof PeriodicExportingMetricReader);
  } finally {
    await shutdownAll(set);
  }
});

test("none and injected build nothing", () => {
  for (const route of ["none", "injected"] as const) {
    const set = createExporterSet(
      { config: config({ traces: route, metrics: route, logs: route }), exemplars: exemplars() },
      fakeDelivery(),
      ALL,
    );
    assert.deepEqual(set, {}, route);
  }
});

test("a metric export timeout above the interval is clamped", async () => {
  const set = createExporterSet(
    {
      config: config({
        traces: "none",
        logs: "none",
        metricExport: { intervalMillis: 100, timeoutMillis: 5000 },
      }),
      exemplars: exemplars(),
    },
    fakeDelivery(),
    ALL,
  );
  try {
    assert.ok(set.metricReader instanceof PeriodicExportingMetricReader);
  } finally {
    await shutdownAll(set);
  }
});

test("http/protobuf on an otlp route is UNSUPPORTED_PROTOCOL", () => {
  for (const signal of ["traces", "metrics", "logs"] as const) {
    const protocol = {
      traces: "http/json",
      metrics: "http/json",
      logs: "http/json",
      [signal]: "http/protobuf",
    };
    assert.throws(
      () => createExporterSet({ config: config({ protocol }), exemplars: exemplars() }, fakeDelivery(), ALL),
      (err: unknown) =>
        err instanceof O11yError && err.code === "UNSUPPORTED_PROTOCOL" && err.message.includes(signal),
      signal,
    );
  }
  // A signal not routed to otlp may name any protocol.
  const set = createExporterSet(
    {
      config: config({
        traces: "none",
        protocol: { traces: "http/protobuf", metrics: "http/json", logs: "http/json" },
      }),
      exemplars: exemplars(),
    },
    fakeDelivery(),
    NONE,
  );
  assert.deepEqual(set, {});
});
