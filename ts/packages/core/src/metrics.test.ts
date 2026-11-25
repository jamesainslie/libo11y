import assert from "node:assert/strict";
import { test } from "node:test";
import { type Context, ROOT_CONTEXT, TraceFlags, trace, ValueType } from "@opentelemetry/api";
import { loggingErrorHandler, setGlobalErrorHandler } from "@opentelemetry/core";
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
  const store = new ExemplarStore({ filter: "trace_based" });
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

test("review W4: a view's histogram boundaries get one exemplar per bucket", async () => {
  const { mp, sdk, collect } = harness({
    views: [
      {
        instrumentName: "h",
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: [0.1, 0.2, 0.3, 0.4, 0.5] },
        },
      },
    ],
  });
  const h = mp.getMeter("svc").createHistogram("h");
  for (const v of [0.05, 0.15, 0.25, 0.35, 0.45]) h.record(v, {}, sampled());
  const [p] = find(await collect(), "h").dataPoints as DataPoint<unknown>[];
  assert.deepEqual(
    exemplarsOf(p as DataPoint<unknown>).map((e) => e.value),
    [0.05, 0.15, 0.25, 0.35, 0.45],
  );
  await sdk.shutdown();
});

// Third review: an instrument call is application code's call, on its hot path, and must never
// throw into it. The attributes are read once into an object the library owns: what cannot be read
// is dropped and reported, and the measurement is still recorded.
const MARKER = "sk_live_MARKER_metric";

function revoked(): never {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy as never;
}

function reporting(opts: { pii?: "drop" | "allow" } = {}) {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const store = new ExemplarStore({ filter: "always_on" });
  const reader = new PeriodicExportingMetricReader({
    exporter: exemplarMetricExporter(exporter, store),
    exportIntervalMillis: 3_600_000,
  });
  const sdk = new MeterProvider({ readers: [reader] });
  const policy = SensitivityPolicy.create({ pii: opts.pii ?? "drop", registries: [] });
  const reports: Error[] = [];
  const mp = new PolicyMeterProvider(sdk, policy, store, (err) => reports.push(err as Error));
  const collect = async (): Promise<MetricData[]> => {
    await reader.forceFlush();
    const all = exporter.getMetrics();
    return all[all.length - 1]?.scopeMetrics.flatMap((sm) => sm.metrics) ?? [];
  };
  return { mp, sdk, collect, reports };
}

function attributesOf(metrics: MetricData[], name: string): unknown[] {
  return (find(metrics, name).dataPoints as DataPoint<unknown>[]).map((p) => p.attributes);
}

test("no synchronous instrument throws on attributes it cannot read: they are dropped, and the measurement is kept", async () => {
  const { mp, sdk, collect, reports } = reporting();
  const meter = mp.getMeter("svc");
  const thrown = new RangeError(`no row for ${MARKER}`);
  const attrs = {
    route: "/a",
    get bad(): string {
      throw thrown;
    },
    "host.ip": "10.0.0.1",
    after: 2,
  };
  try {
    const counter = meter.createCounter("c");
    const upDown = meter.createUpDownCounter("u");
    const histogram = meter.createHistogram("h");
    const gauge = meter.createGauge("g");
    assert.doesNotThrow(() => counter.add(1, attrs));
    assert.doesNotThrow(() => upDown.add(-1, attrs));
    assert.doesNotThrow(() => histogram.record(0.5, attrs));
    assert.doesNotThrow(() => gauge.record(7, attrs));
    assert.doesNotThrow(() => counter.add(1, revoked()));
    assert.doesNotThrow(() => histogram.record(0.5, { tags: revoked() } as never));
    assert.doesNotThrow(() => counter.add(1, null as never));

    const metrics = await collect();
    // What comes after the attribute that cannot be read is still kept.
    const kept = { route: "/a", after: 2 };
    for (const name of ["u", "g"]) assert.deepEqual(attributesOf(metrics, name), [kept], name);
    assert.deepEqual(attributesOf(metrics, "c"), [kept, {}]);
    assert.deepEqual(attributesOf(metrics, "h"), [kept, {}]);
    assert.deepEqual(
      reports.map((r) => r.message),
      [
        ...Array.from(
          { length: 4 },
          () => 'o11y: metric attribute "bad" cannot be read and is dropped: RangeError',
        ),
        "o11y: metric attributes cannot be read and are dropped: TypeError",
        'o11y: metric attribute "tags" cannot be read and is dropped: TypeError',
      ],
    );
    assert.equal(reports[0]?.cause, thrown);
    for (const r of reports) assert.ok(!`${r.message}${r.stack}`.includes("MARKER"));
  } finally {
    await sdk.shutdown();
  }
});

test("observable callbacks can observe attributes that cannot be read without the callback failing", async () => {
  const { mp, sdk, collect, reports } = reporting();
  const meter = mp.getMeter("svc");
  let finished = 0;
  try {
    const single = meter.createObservableGauge("single");
    single.addCallback((result) => {
      result.observe(1, revoked());
      result.observe(2, {
        route: "/a",
        get bad(): string {
          throw new Error(MARKER);
        },
      });
      finished++;
    });
    const batched = meter.createObservableCounter("batched");
    meter.addBatchObservableCallback(
      (result) => {
        result.observe(batched, 3, revoked());
        finished++;
      },
      [batched],
    );
    const metrics = await collect();
    assert.equal(finished, 2, "neither callback was cut short");
    assert.deepEqual(attributesOf(metrics, "single"), [{}, { route: "/a" }]);
    assert.deepEqual(attributesOf(metrics, "batched"), [{}]);
    assert.deepEqual(
      reports.map((r) => r.message),
      [
        "o11y: metric attributes cannot be read and are dropped: TypeError",
        'o11y: metric attribute "bad" cannot be read and is dropped: Error',
        "o11y: metric attributes cannot be read and are dropped: TypeError",
      ],
    );
  } finally {
    await sdk.shutdown();
  }
});

test("a measurement's attributes are read once and owned: a later change by the caller does not reach the point", async () => {
  const { mp, sdk, collect, reports } = reporting();
  const meter = mp.getMeter("svc");
  let reads = 0;
  const tags = ["a", "b"];
  const attrs: Record<string, unknown> = {
    route: "/a",
    tags,
    get counted(): number {
      reads++;
      return reads;
    },
  };
  try {
    meter.createCounter("c").add(1, attrs as never, sampled());
    assert.equal(reads, 1, "the getter ran once, not once for the SDK and again for the exemplar store");
    attrs.route = "/changed";
    tags.push("c");
    const metrics = await collect();
    assert.deepEqual(attributesOf(metrics, "c"), [{ route: "/a", tags: ["a", "b"], counted: 1 }]);
    assert.deepEqual(reports, []);
  } finally {
    await sdk.shutdown();
  }
});

test("an instrument the SDK cannot record on is reported, never thrown", () => {
  const policy = SensitivityPolicy.create({ pii: "drop", registries: [] });
  const reports: Error[] = [];
  const broken = {
    getMeter: () => ({
      createCounter: () => ({
        add: () => {
          throw new Error(MARKER);
        },
      }),
    }),
  };
  const mp = new PolicyMeterProvider(
    broken as never,
    policy,
    new ExemplarStore({ filter: "always_off" }),
    (err) => reports.push(err as Error),
  );
  assert.doesNotThrow(() => mp.getMeter("svc").createCounter("jobs").add(1, { route: "/a" }));
  assert.deepEqual(
    reports.map((r) => r.message),
    ['o11y: recording on "jobs" failed, the measurement is dropped: Error'],
  );
});

test("without a reporter of its own the meter provider reports to the global error handler", () => {
  const policy = SensitivityPolicy.create({ pii: "drop", registries: [] });
  const sdk = new MeterProvider();
  const mp = new PolicyMeterProvider(sdk, policy, new ExemplarStore({ filter: "always_off" }));
  const reports: string[] = [];
  setGlobalErrorHandler((err) => {
    reports.push((err as Error).message);
  });
  try {
    assert.doesNotThrow(() => mp.getMeter("svc").createCounter("c").add(1, revoked()));
  } finally {
    setGlobalErrorHandler(loggingErrorHandler());
  }
  assert.deepEqual(reports, ["o11y: metric attributes cannot be read and are dropped: TypeError"]);
});

// What a measurement costs the caller's object, counted: one listing of the keys and one read of
// each kept value. The SDK and the exemplar store work on the library's copy. This also guards the
// hot path: a second listing or a second read would show here.
test("a measurement lists the caller's keys once and reads each kept value once, and never reads a dropped one", async () => {
  const { mp, sdk, collect, reports } = reporting();
  const traps: string[] = [];
  const target = {
    "http.request.method": "GET",
    "http.route": "/items/:id",
    "http.response.status_code": 200,
    "url.scheme": "https",
    "server.port": 443,
    "http.request.header.authorization": "Bearer secret",
  };
  const counted = new Proxy(target, {
    ownKeys(t) {
      traps.push("ownKeys");
      return Reflect.ownKeys(t);
    },
    get(t, key, receiver) {
      traps.push(`get ${String(key)}`);
      return Reflect.get(t, key, receiver);
    },
  });
  try {
    mp.getMeter("svc").createHistogram("h").record(0.25, counted, sampled());
    assert.deepEqual(traps, [
      "ownKeys",
      "get http.request.method",
      "get http.route",
      "get http.response.status_code",
      "get url.scheme",
      "get server.port",
    ]);
    const [point] = find(await collect(), "h").dataPoints as DataPoint<unknown>[];
    assert.deepEqual(point?.attributes, {
      "http.request.method": "GET",
      "http.route": "/items/:id",
      "http.response.status_code": 200,
      "url.scheme": "https",
      "server.port": 443,
    });
    assert.equal(exemplarsOf(point as DataPoint<unknown>).length, 1, "the exemplar joined the owned copy");
    assert.equal(traps.length, 6, "collecting and attaching read nothing more from the caller's object");
    assert.deepEqual(reports, []);
  } finally {
    await sdk.shutdown();
  }
});
