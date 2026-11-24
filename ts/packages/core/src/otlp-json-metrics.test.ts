import assert from "node:assert/strict";
import { test } from "node:test";
import { type Context, ROOT_CONTEXT, TraceFlags, trace, ValueType } from "@opentelemetry/api";
import { JsonMetricsSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationType,
  MeterProvider,
  MetricReader,
  type ResourceMetrics,
  type ViewOptions,
} from "@opentelemetry/sdk-metrics";
import { ExemplarStore } from "./exemplars.ts";
import { PolicyMeterProvider } from "./metrics.ts";
import { OtlpJsonMetricsSerializer, toOtlpMetricsObject } from "./otlp-json-metrics.ts";
import { SensitivityPolicy } from "./policy.ts";

class TestReader extends MetricReader {
  protected override async onShutdown(): Promise<void> {}
  protected override async onForceFlush(): Promise<void> {}
}

function decode(bytes: Uint8Array | undefined): unknown {
  assert.ok(bytes);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function collect(
  record: (mp: MeterProvider) => void,
  opts: { views?: ViewOptions[]; resource?: Record<string, unknown> } = {},
): Promise<ResourceMetrics> {
  const reader = new TestReader();
  const mp = new MeterProvider({
    readers: [reader],
    views: opts.views ?? [],
    ...(opts.resource === undefined
      ? {}
      : {
          resource: resourceFromAttributes(opts.resource as Record<string, string>, {
            schemaUrl: "https://x/1",
          }),
        }),
  });
  record(mp);
  const { resourceMetrics } = await reader.collect();
  await mp.shutdown();
  return resourceMetrics;
}

const FIXTURES: Record<string, () => Promise<ResourceMetrics>> = {
  sum: () =>
    collect((mp) => {
      const m = mp.getMeter("svc", "1.0.0");
      m.createCounter("requests", { unit: "{request}", description: "d", valueType: ValueType.INT }).add(3, {
        a: "x",
      });
      m.createUpDownCounter("inflight").add(-2.5, { b: true });
    }),
  gauge: () =>
    collect((mp) => {
      mp.getMeter("svc")
        .createGauge("temp", { unit: "Cel" })
        .record(21.5, { room: "a", n: 3, list: ["p", "q"] });
    }),
  histogram: () =>
    collect((mp) => {
      const h = mp
        .getMeter("svc")
        .createHistogram("dur", { unit: "s", advice: { explicitBucketBoundaries: [0.1, 1] } });
      h.record(0.05, { r: "/a" });
      h.record(5, { r: "/a" });
      h.record(0.5, { r: "/b" });
    }),
  exponentialHistogram: () =>
    collect(
      (mp) => {
        const h = mp.getMeter("svc").createHistogram("exp");
        for (const v of [1, 2, 4, 1000, 0, 0.001]) h.record(v, { k: "v" });
      },
      { views: [{ instrumentName: "exp", aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM } }] },
    ),
  scopes: () =>
    collect((mp) => {
      mp.getMeter("a", "1").createCounter("ca").add(1);
      mp.getMeter("b", "2", { schemaUrl: "https://opentelemetry.io/schemas/1.41.0" })
        .createCounter("cb")
        .add(2);
      mp.getMeter("c").createGauge("gc").record(-1);
    }),
  resource: () =>
    collect(
      (mp) => {
        mp.getMeter("svc").createCounter("c").add(1);
      },
      {
        resource: {
          "service.name": "svc",
          "service.version": "1.2.3",
          "process.pid": 42,
          ratio: 0.25,
          flag: false,
          tags: ["a", "b"],
          "deployment.environment.name": "test",
        },
      },
    ),
};

for (const [name, fixture] of Object.entries(FIXTURES)) {
  test(`exemplar-free ${name} output deep-equals upstream JsonMetricsSerializer`, async () => {
    const rm = await fixture();
    const ours = decode(OtlpJsonMetricsSerializer.serializeRequest(rm));
    assert.deepEqual(ours, decode(JsonMetricsSerializer.serializeRequest(rm)));
    assert.deepEqual(toOtlpMetricsObject(rm), ours);
  });
}

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

function sampled(): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
  });
}

test("exemplars are added to their points in OTLP/JSON form", async () => {
  const store = new ExemplarStore({ filter: "trace_based" });
  const reader = new TestReader();
  const sdk = new MeterProvider({
    readers: [reader],
    views: [{ instrumentName: "h", attributesProcessors: [] }],
  });
  const mp = new PolicyMeterProvider(sdk, SensitivityPolicy.create({ pii: "drop", registries: [] }), store);
  const meter = mp.getMeter("svc");
  meter.createHistogram("h").record(7.5, { r: "/a" }, sampled());
  meter.createCounter("c", { valueType: ValueType.INT }).add(2, { r: "/a" }, sampled());
  meter.createCounter("plain").add(1, {}, ROOT_CONTEXT);
  const { resourceMetrics } = await reader.collect();
  await sdk.shutdown();
  const attached = store.attach(resourceMetrics);

  const json = decode(OtlpJsonMetricsSerializer.serializeRequest(attached)) as {
    resourceMetrics: {
      scopeMetrics: { metrics: Record<string, { dataPoints: Record<string, unknown>[] }>[] }[];
    }[];
  };
  const metrics = json.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
  const byName = Object.fromEntries(metrics.map((m) => [m.name as unknown as string, m]));
  const hPoint = byName.h?.histogram?.dataPoints[0];
  assert.ok(hPoint);
  const [he] = hPoint.exemplars as Record<string, unknown>[];
  assert.ok(he);
  assert.equal(typeof he.timeUnixNano, "string");
  assert.match(he.timeUnixNano as string, /^\d+$/);
  assert.equal(he.asDouble, 7.5);
  assert.equal(he.traceId, TRACE_ID);
  assert.equal(he.spanId, SPAN_ID);
  assert.deepEqual(he.filteredAttributes, []);

  const cPoint = byName.c?.sum?.dataPoints[0];
  const [ce] = (cPoint?.exemplars ?? []) as Record<string, unknown>[];
  assert.equal(ce?.asInt, 2);
  assert.equal(ce?.asDouble, undefined);

  const plain = byName.plain?.sum?.dataPoints[0];
  assert.equal(Object.hasOwn(plain ?? {}, "exemplars"), false);
});

test("filteredAttributes use upstream's key/value form", async () => {
  const store = new ExemplarStore({ filter: "always_on" });
  const reader = new TestReader();
  const sdk = new MeterProvider({
    readers: [reader],
    views: [{ instrumentName: "c", attributesProcessors: [{ process: () => ({}) }] }],
  });
  const mp = new PolicyMeterProvider(sdk, SensitivityPolicy.create({ pii: "drop", registries: [] }), store);
  mp.getMeter("svc")
    .createCounter("c")
    .add(1, { s: "x", i: 3, d: 1.5, b: true, a: ["p"] });
  const { resourceMetrics } = await reader.collect();
  await sdk.shutdown();
  const obj = toOtlpMetricsObject(store.attach(resourceMetrics));
  const point = obj.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.sum?.dataPoints[0];
  assert.deepEqual(point?.exemplars?.[0]?.filteredAttributes, [
    { key: "s", value: { stringValue: "x" } },
    { key: "i", value: { intValue: 3 } },
    { key: "d", value: { doubleValue: 1.5 } },
    { key: "b", value: { boolValue: true } },
    { key: "a", value: { arrayValue: { values: [{ stringValue: "p" }] } } },
  ]);
  assert.equal(point?.exemplars?.[0]?.traceId, undefined);
});

test("deserializeResponse is upstream's", () => {
  const body = new TextEncoder().encode('{"partialSuccess":{"rejectedDataPoints":"1"}}');
  assert.deepEqual(
    OtlpJsonMetricsSerializer.deserializeResponse(body),
    JsonMetricsSerializer.deserializeResponse(body),
  );
  assert.deepEqual(OtlpJsonMetricsSerializer.deserializeResponse(new Uint8Array(0)), {});
});
