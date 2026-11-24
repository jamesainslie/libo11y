import assert from "node:assert/strict";
import { test } from "node:test";
import { exemplarsOf, OtlpJsonMetricsSerializer, type ResourceMetricsWithExemplars } from "@libo11y/core";
import { decodeOtlpProtobuf, normalizeOtlp } from "@libo11y/test";
import { ROOT_CONTEXT, trace, ValueType } from "@opentelemetry/api";
import { ProtobufMetricsSerializer } from "@opentelemetry/otlp-transformer";
import { AggregationType, type DataPoint } from "@opentelemetry/sdk-metrics";
import { encodeMetricsRequest, OtlpProtobufMetricsSerializer } from "./otlp-proto-metrics.ts";
import { type MetricsRig, metricsRig } from "./test-support/metrics.ts";

async function withRig(fn: (rec: MetricsRig) => Promise<void>): Promise<void> {
  const rec = await metricsRig({
    serviceName: "proto-test",
    views: [{ instrumentName: "app.exp", aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM } }],
  });
  try {
    await fn(rec);
  } finally {
    await rec.shutdown();
  }
}

// recordEveryKind records every OTLP metric kind upstream emits, across two scopes, outside any
// span, so the trace-based filter samples no exemplars.
function recordEveryKind(rec: MetricsRig): void {
  const meter = rec.telemetry.meterProvider.getMeter("app", "1.0.0");
  meter.createCounter("app.jobs", { unit: "{job}", description: "Jobs.", valueType: ValueType.INT }).add(3, {
    "app.kind": "a",
  });
  meter.createCounter("app.jobs", { unit: "{job}", description: "Jobs.", valueType: ValueType.INT }).add(5, {
    "app.kind": "b",
  });
  meter.createUpDownCounter("app.queue").add(-2.5);
  meter.createCounter("app.big", { valueType: ValueType.INT }).add(2 ** 40);
  meter.createHistogram("app.latency", { unit: "s" }).record(0.2, { "app.route": "/x" });
  meter.createHistogram("app.size", { advice: { explicitBucketBoundaries: [] } }).record(4);
  const exp = meter.createHistogram("app.exp");
  for (const v of [0, 0.001, 3, 250, -7, 1e6]) exp.record(v);
  meter.createGauge("app.temp").record(21.5, { "app.list": ["a", "b"], "app.flag": true, "app.n": -9 });
  meter.createObservableGauge("app.int.gauge", { valueType: ValueType.INT }).addCallback((r) => r.observe(9));
  const other = rec.telemetry.meterProvider.getMeter("other", undefined, {
    schemaUrl: "https://opentelemetry.io/schemas/1.41.0",
  });
  other.createCounter("other.count").add(1.25);
}

function kinds(decoded: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  for (const rm of decoded.resourceMetrics as { scopeMetrics: { metrics: Record<string, unknown>[] }[] }[]) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        for (const k of ["sum", "gauge", "histogram", "exponentialHistogram"]) if (k in m) found.add(k);
      }
    }
  }
  return found;
}

test("exemplar-free metrics encode exactly as upstream's ProtobufMetricsSerializer", async () => {
  await withRig(async (rec) => {
    recordEveryKind(rec);
    const rm = await rec.collect();
    const ours = OtlpProtobufMetricsSerializer.serializeRequest(rm) as Uint8Array;
    const upstream = ProtobufMetricsSerializer.serializeRequest(rm) as Uint8Array;
    const decoded = decodeOtlpProtobuf("metrics", ours);
    assert.deepEqual(normalizeOtlp(decoded), normalizeOtlp(decodeOtlpProtobuf("metrics", upstream)));
    assert.deepEqual(kinds(decoded), new Set(["sum", "gauge", "histogram", "exponentialHistogram"]));
    assert.equal((decoded.resourceMetrics as { scopeMetrics: unknown[] }[])[0]?.scopeMetrics.length, 2);
    // The field order follows upstream's too, so the bytes are the same.
    assert.deepEqual(Buffer.from(ours).toString("hex"), Buffer.from(upstream).toString("hex"));
  });
});

test("several resources encode as several ResourceMetrics, in order", async () => {
  let first: ResourceMetricsWithExemplars | undefined;
  await withRig(async (rec) => {
    recordEveryKind(rec);
    first = await rec.collect();
  });
  await withRig(async (rec) => {
    rec.telemetry.meterProvider.getMeter("second").createCounter("second.count").add(2);
    const second = await rec.collect();
    const a = first as ResourceMetricsWithExemplars;
    const decoded = decodeOtlpProtobuf("metrics", encodeMetricsRequest([a, second]));
    const one = (rm: ResourceMetricsWithExemplars): unknown =>
      (
        decodeOtlpProtobuf("metrics", ProtobufMetricsSerializer.serializeRequest(rm) as Uint8Array)
          .resourceMetrics as unknown[]
      )[0];
    assert.deepEqual(normalizeOtlp(decoded), normalizeOtlp({ resourceMetrics: [one(a), one(second)] }));
  });
});

test("non-finite doubles survive as upstream writes them", async () => {
  await withRig(async (rec) => {
    const meter = rec.telemetry.meterProvider.getMeter("app");
    meter.createGauge("app.nan").record(Number.NaN);
    meter.createGauge("app.inf").record(Number.POSITIVE_INFINITY);
    meter.createGauge("app.neg.inf").record(Number.NEGATIVE_INFINITY);
    const rm = await rec.collect();
    const ours = decodeOtlpProtobuf(
      "metrics",
      OtlpProtobufMetricsSerializer.serializeRequest(rm) as Uint8Array,
    );
    const upstream = decodeOtlpProtobuf(
      "metrics",
      ProtobufMetricsSerializer.serializeRequest(rm) as Uint8Array,
    );
    assert.deepEqual(normalizeOtlp(ours), normalizeOtlp(upstream));
    const values = JSON.stringify(ours, (_k, v) =>
      typeof v === "number" && !Number.isFinite(v) ? String(v) : v,
    );
    for (const v of ['"NaN"', '"Infinity"', '"-Infinity"']) assert.ok(values.includes(v), v);
  });
});

test("exemplars survive on sums, gauges, histograms and exponential histograms", async () => {
  await withRig(async (rec) => {
    const tracer = rec.telemetry.tracerProvider.getTracer("app");
    const meter = rec.telemetry.meterProvider.getMeter("app", "1.0.0");
    let traceId = "";
    let spanId = "";
    const span = tracer.startSpan("work");
    const ctx = trace.setSpan(ROOT_CONTEXT, span);
    traceId = span.spanContext().traceId;
    spanId = span.spanContext().spanId;
    meter
      .createCounter("app.jobs", { valueType: ValueType.INT })
      .add(4, { "app.kind": "a", "app.extra": "x" }, ctx);
    meter.createHistogram("app.latency", { unit: "s" }).record(0.3, {}, ctx);
    meter.createHistogram("app.exp").record(42, {}, ctx);
    meter.createGauge("app.temp").record(20.5, {}, ctx);
    span.end();
    const rm = await rec.collect();
    const points: DataPoint<unknown>[] = rm.scopeMetrics.flatMap((sm) =>
      sm.metrics.flatMap((m): DataPoint<unknown>[] => m.dataPoints),
    );
    assert.ok(
      points.some((p) => exemplarsOf(p).length > 0),
      "the recorder attached exemplars",
    );

    const decoded = decodeOtlpProtobuf(
      "metrics",
      OtlpProtobufMetricsSerializer.serializeRequest(rm) as Uint8Array,
    );
    // The protobuf carries exactly what core's JSON serializer writes, exemplars included.
    const json = JSON.parse(new TextDecoder().decode(OtlpJsonMetricsSerializer.serializeRequest(rm)));
    assert.deepEqual(normalizeOtlp(decoded), normalizeOtlp(json));

    const exemplars = new Map<string, Record<string, unknown>[]>();
    for (const rmJson of decoded.resourceMetrics as {
      scopeMetrics: { metrics: Record<string, unknown>[] }[];
    }[]) {
      for (const sm of rmJson.scopeMetrics) {
        for (const m of sm.metrics) {
          const holder = (m.sum ?? m.gauge ?? m.histogram ?? m.exponentialHistogram) as {
            dataPoints: { exemplars?: Record<string, unknown>[] }[];
          };
          exemplars.set(
            String(m.name),
            holder.dataPoints.flatMap((p) => p.exemplars ?? []),
          );
        }
      }
    }
    for (const name of ["app.jobs", "app.latency", "app.exp", "app.temp"]) {
      const [e] = exemplars.get(name) ?? [];
      assert.ok(e !== undefined, `${name} has an exemplar`);
      assert.equal(e.traceId, traceId, name);
      assert.equal(e.spanId, spanId, name);
      assert.match(String(e.timeUnixNano), /^\d{19}$/, name);
    }
    const [jobs] = exemplars.get("app.jobs") ?? [];
    assert.equal(jobs?.asInt, 4);
    assert.equal(jobs?.asDouble, undefined);
    assert.equal((exemplars.get("app.latency") ?? [])[0]?.asDouble, 0.3);
  });
});

test("an exemplar without a trace carries no IDs", async () => {
  const rec = await metricsRig({ exemplarFilter: "always_on" });
  try {
    rec.telemetry.meterProvider.getMeter("app").createHistogram("app.latency").record(1.5);
    const rm = await rec.collect();
    const decoded = decodeOtlpProtobuf(
      "metrics",
      OtlpProtobufMetricsSerializer.serializeRequest(rm) as Uint8Array,
    );
    const json = JSON.parse(new TextDecoder().decode(OtlpJsonMetricsSerializer.serializeRequest(rm)));
    assert.deepEqual(normalizeOtlp(decoded), normalizeOtlp(json));
    const text = JSON.stringify(decoded);
    assert.ok(text.includes('"exemplars"'));
    assert.ok(!text.includes('"traceId"'));
  } finally {
    await rec.shutdown();
  }
});

test("deserializeResponse decodes an export response as upstream does", () => {
  assert.deepEqual(OtlpProtobufMetricsSerializer.deserializeResponse(new Uint8Array(0)), {});
});
