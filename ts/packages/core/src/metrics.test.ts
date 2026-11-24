import assert from "node:assert/strict";
import { test } from "node:test";
import { type Context, ROOT_CONTEXT, TraceFlags, trace, ValueType } from "@opentelemetry/api";
import {
  AggregationTemporality,
  AggregationType,
  createAllowListAttributesProcessor,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  type MetricData,
  PeriodicExportingMetricReader,
  type ViewOptions,
} from "@opentelemetry/sdk-metrics";
import { ExemplarStore, exemplarMetricExporter, exemplarsOf } from "./exemplars.ts";
import { PolicyMeterProvider } from "./metrics.ts";
import { SensitivityPolicy } from "./policy.ts";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

function sampled(): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
  });
}

function harness(opts: { views?: ViewOptions[]; pii?: "drop" | "allow" } = {}) {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const store = new ExemplarStore({ filter: "trace_based", histogramBuckets: {} });
  const reader = new PeriodicExportingMetricReader({
    exporter: exemplarMetricExporter(exporter, store),
    exportIntervalMillis: 3_600_000,
  });
  const sdk = new MeterProvider({ readers: [reader], views: opts.views ?? [] });
  const policy = SensitivityPolicy.create({ pii: opts.pii ?? "drop", registries: [] });
  const mp = new PolicyMeterProvider(sdk, policy, store);
  const collect = async (): Promise<MetricData[]> => {
    await reader.forceFlush();
    const all = exporter.getMetrics();
    const last = all[all.length - 1];
    return last?.scopeMetrics.flatMap((sm) => sm.metrics) ?? [];
  };
  return { mp, sdk, collect, exporter };
}

function find(metrics: MetricData[], name: string): MetricData {
  const m = metrics.find((x) => x.descriptor.name === name);
  assert.ok(m, `metric ${name}`);
  return m;
}

test("sync instruments drop secret and PII attributes before recording", async () => {
  const { mp, sdk, collect } = harness();
  const meter = mp.getMeter("svc");
  const attrs = { "http.request.header.authorization": "Bearer x", "host.ip": "10.0.0.1", route: "/a" };
  meter.createCounter("c").add(1, attrs);
  meter.createUpDownCounter("u").add(-1, attrs);
  meter.createHistogram("h").record(5, attrs);
  meter.createGauge("g").record(7, attrs);
  const metrics = await collect();
  for (const name of ["c", "u", "h", "g"]) {
    const points = find(metrics, name).dataPoints as DataPoint<unknown>[];
    assert.deepEqual(
      points.map((p) => p.attributes),
      [{ route: "/a" }],
      name,
    );
  }
  await sdk.shutdown();
});

test("allow mode keeps PII on metric points but never secrets", async () => {
  const { mp, sdk, collect } = harness({ pii: "allow" });
  mp.getMeter("svc")
    .createCounter("c")
    .add(1, { "http.request.header.authorization": "Bearer x", "host.ip": "10.0.0.1" });
  const [point] = find(await collect(), "c").dataPoints as DataPoint<unknown>[];
  assert.deepEqual(point?.attributes, { "host.ip": "10.0.0.1" });
  await sdk.shutdown();
});

test("observable callbacks are classified, single and batch", async () => {
  const { mp, sdk, collect } = harness();
  const meter = mp.getMeter("svc");
  const og = meter.createObservableGauge("og", { valueType: ValueType.INT });
  const cb = (r: { observe(v: number, a?: Record<string, string>): void }) =>
    r.observe(3, { "host.ip": "10.0.0.1", k: "v" });
  og.addCallback(cb);
  const oc = meter.createObservableCounter("oc");
  const ou = meter.createObservableUpDownCounter("ou");
  meter.addBatchObservableCallback(
    (r) => {
      r.observe(oc, 1, { "host.ip": "x", k: "c" });
      r.observe(ou, 2, { "host.ip": "x", k: "u" });
    },
    [oc, ou],
  );
  const metrics = await collect();
  assert.deepEqual((find(metrics, "og").dataPoints[0] as DataPoint<unknown>).attributes, { k: "v" });
  assert.deepEqual((find(metrics, "oc").dataPoints[0] as DataPoint<unknown>).attributes, { k: "c" });
  assert.deepEqual((find(metrics, "ou").dataPoints[0] as DataPoint<unknown>).attributes, { k: "u" });

  og.removeCallback(cb);
  const after = await collect();
  assert.equal(after.find((m) => m.descriptor.name === "og")?.dataPoints.length ?? 0, 1);
  await sdk.shutdown();
});

test("a removed batch callback stops observing", async () => {
  const { mp, sdk, collect } = harness();
  const meter = mp.getMeter("svc");
  const oc = meter.createObservableCounter("oc");
  let calls = 0;
  const cb = (r: { observe(o: typeof oc, v: number): void }) => {
    calls++;
    r.observe(oc, 1);
  };
  meter.addBatchObservableCallback(cb, [oc]);
  await collect();
  meter.removeBatchObservableCallback(cb, [oc]);
  await collect();
  assert.equal(calls, 1);
  await sdk.shutdown();
});

test("a measurement inside a sampled span gets an exemplar with the span's IDs", async () => {
  const { mp, sdk, collect } = harness();
  const meter = mp.getMeter("svc");
  meter
    .createHistogram("h", { advice: { explicitBucketBoundaries: [1, 10] } })
    .record(5, { route: "/a" }, sampled());
  meter.createCounter("c").add(2, { route: "/a" }, sampled());
  meter.createCounter("c").add(2, { route: "/a" }, ROOT_CONTEXT);
  const metrics = await collect();
  const [hp] = find(metrics, "h").dataPoints as DataPoint<unknown>[];
  const [he] = exemplarsOf(hp as DataPoint<unknown>);
  assert.equal(he?.traceId, TRACE_ID);
  assert.equal(he?.spanId, SPAN_ID);
  assert.equal(he?.value, 5);
  const [cp] = find(metrics, "c").dataPoints as DataPoint<unknown>[];
  assert.equal(exemplarsOf(cp as DataPoint<unknown>).length, 1);
  await sdk.shutdown();
});

test("measurements the SDK rejects are not sampled", async () => {
  const { mp, sdk, collect } = harness();
  const meter = mp.getMeter("svc");
  meter.createCounter("c").add(-1, {}, sampled());
  meter.createHistogram("h").record(-1, {}, sampled());
  const metrics = await collect();
  for (const m of metrics) {
    for (const p of m.dataPoints as DataPoint<unknown>[]) assert.deepEqual(exemplarsOf(p), []);
  }
  await sdk.shutdown();
});

test("filteredAttributes holds the keys a user view dropped, never a PII key", async () => {
  const { mp, sdk, collect } = harness({
    views: [{ instrumentName: "h", attributesProcessors: [createAllowListAttributesProcessor(["route"])] }],
  });
  mp.getMeter("svc")
    .createHistogram("h")
    .record(5, { route: "/a", method: "GET", "host.ip": "10.0.0.1" }, sampled());
  const [p] = find(await collect(), "h").dataPoints as DataPoint<unknown>[];
  assert.deepEqual(p?.attributes, { route: "/a" });
  const [e] = exemplarsOf(p as DataPoint<unknown>);
  assert.deepEqual(e?.filteredAttributes, { method: "GET" });
  await sdk.shutdown();
});

test("user views still apply through the wrapper", async () => {
  const { mp, sdk, collect } = harness({
    views: [
      {
        instrumentName: "h",
        aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: [100] } },
      },
    ],
  });
  mp.getMeter("svc").createHistogram("h").record(5, {}, sampled());
  const [p] = find(await collect(), "h").dataPoints as DataPoint<{ buckets: { boundaries: number[] } }>[];
  assert.deepEqual(p?.value.buckets.boundaries, [100]);
  await sdk.shutdown();
});
