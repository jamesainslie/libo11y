import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Attributes,
  type Context,
  ROOT_CONTEXT,
  TraceFlags,
  trace,
  ValueType,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  type DataPoint,
  DataPointType,
  type Histogram,
  type MetricData,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { ExemplarStore, exemplarsOf, scopeKey } from "./exemplars.ts";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

function spanContext(sampled: boolean): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
  });
}

const SCOPE = { name: "svc", version: "" };
const KEY = scopeKey(SCOPE.name, SCOPE.version, undefined);

function at(ms: number): [number, number] {
  return [Math.trunc(ms / 1000), (ms % 1000) * 1_000_000];
}

function sumMetric(name: string, points: { attrs: Attributes; end: number }[]): MetricData {
  return {
    descriptor: { name, description: "", unit: "", valueType: ValueType.DOUBLE },
    aggregationTemporality: AggregationTemporality.CUMULATIVE,
    dataPointType: DataPointType.SUM,
    isMonotonic: true,
    dataPoints: points.map((p) => ({ startTime: at(0), endTime: at(p.end), attributes: p.attrs, value: 1 })),
  };
}

function histogramMetric(
  name: string,
  boundaries: number[],
  end: number,
  attrs: Attributes = {},
): MetricData {
  return {
    descriptor: { name, description: "", unit: "", valueType: ValueType.DOUBLE },
    aggregationTemporality: AggregationTemporality.CUMULATIVE,
    dataPointType: DataPointType.HISTOGRAM,
    dataPoints: [
      {
        startTime: at(0),
        endTime: at(end),
        attributes: attrs,
        value: {
          buckets: { boundaries, counts: [...boundaries.map(() => 0), 0] },
          sum: 0,
          count: 0,
        },
      } satisfies DataPoint<Histogram>,
    ],
  };
}

function rmOf(...metrics: MetricData[]): ResourceMetrics {
  return { resource: resourceFromAttributes({}), scopeMetrics: [{ scope: SCOPE, metrics }] };
}

function pointsOf(rm: ResourceMetrics, metric = 0): DataPoint<unknown>[] {
  return (rm.scopeMetrics[0]?.metrics[metric]?.dataPoints ?? []) as DataPoint<unknown>[];
}

function store(filter: "trace_based" | "always_on" | "always_off" = "trace_based", maxSeries?: number) {
  return new ExemplarStore({
    filter,
    histogramBuckets: { "req.duration": [10, 100] },
    ...(maxSeries === undefined ? {} : { maxSeries }),
  });
}

test("trace_based keeps a sampled measurement with its IDs and skips an unsampled one", () => {
  const s = store();
  s.offer({
    scope: KEY,
    instrument: "c",
    kind: "sum",
    value: 3,
    attributes: {},
    context: spanContext(true),
    time: at(10),
  });
  s.offer({
    scope: KEY,
    instrument: "c",
    kind: "sum",
    value: 4,
    attributes: {},
    context: spanContext(false),
    time: at(11),
  });
  s.offer({
    scope: KEY,
    instrument: "c",
    kind: "sum",
    value: 5,
    attributes: {},
    context: ROOT_CONTEXT,
    time: at(12),
  });
  const [point] = pointsOf(s.attach(rmOf(sumMetric("c", [{ attrs: {}, end: 20 }]))));
  assert.ok(point);
  assert.deepEqual(exemplarsOf(point), [
    { timeUnixNano: 10_000_000n, value: 3, traceId: TRACE_ID, spanId: SPAN_ID, filteredAttributes: {} },
  ]);
});

test("always_on keeps every measurement and always_off keeps none", () => {
  const on = store("always_on");
  on.offer({
    scope: KEY,
    instrument: "c",
    kind: "sum",
    value: 1,
    attributes: {},
    context: ROOT_CONTEXT,
    time: at(1),
  });
  on.offer({
    scope: KEY,
    instrument: "c",
    kind: "sum",
    value: 2,
    attributes: {},
    context: spanContext(false),
    time: at(2),
  });
  const [p] = pointsOf(on.attach(rmOf(sumMetric("c", [{ attrs: {}, end: 5 }]))));
  assert.ok(p);
  const got = exemplarsOf(p);
  assert.equal(got.length, 2);
  assert.equal(got[0]?.traceId, undefined);
  assert.equal(got[1]?.traceId, TRACE_ID);

  const off = store("always_off");
  off.offer({
    scope: KEY,
    instrument: "c",
    kind: "sum",
    value: 1,
    attributes: {},
    context: spanContext(true),
    time: at(1),
  });
  const [q] = pointsOf(off.attach(rmOf(sumMetric("c", [{ attrs: {}, end: 5 }]))));
  assert.ok(q);
  assert.deepEqual(exemplarsOf(q), []);
});

test("a non-histogram point carries at most 4 exemplars", () => {
  const s = store();
  for (let i = 0; i < 50; i++) {
    s.offer({
      scope: KEY,
      instrument: "c",
      kind: "sum",
      value: i,
      attributes: {},
      context: spanContext(true),
      time: at(i),
    });
  }
  const [p] = pointsOf(s.attach(rmOf(sumMetric("c", [{ attrs: {}, end: 100 }]))));
  assert.ok(p);
  assert.equal(exemplarsOf(p).length, 4);
});

test("a histogram keeps the latest exemplar per bucket, aligned to the point's boundaries", () => {
  const s = store();
  const offer = (value: number, ms: number) =>
    s.offer({
      scope: KEY,
      instrument: "req.duration",
      kind: "histogram",
      value,
      attributes: {},
      context: spanContext(true),
      time: at(ms),
    });
  offer(5, 1); // bucket 0
  offer(7, 2); // bucket 0, later: wins
  offer(10, 3); // bucket 0 (upper bound inclusive)
  offer(50, 4); // bucket 1
  offer(1000, 5); // bucket 2 (overflow)
  const [p] = pointsOf(s.attach(rmOf(histogramMetric("req.duration", [10, 100], 50))));
  assert.ok(p);
  assert.deepEqual(
    exemplarsOf(p).map((e) => e.value),
    [10, 50, 1000],
  );
});

test("an exemplar newer than the point's end time carries to the next cycle", () => {
  const s = store();
  s.offer({
    scope: KEY,
    instrument: "c",
    kind: "sum",
    value: 1,
    attributes: {},
    context: spanContext(true),
    time: at(10),
  });
  s.offer({
    scope: KEY,
    instrument: "c",
    kind: "sum",
    value: 2,
    attributes: {},
    context: spanContext(true),
    time: at(30),
  });
  const [first] = pointsOf(s.attach(rmOf(sumMetric("c", [{ attrs: {}, end: 20 }]))));
  assert.deepEqual(
    exemplarsOf(first as DataPoint<unknown>).map((e) => e.value),
    [1],
  );
  const [second] = pointsOf(s.attach(rmOf(sumMetric("c", [{ attrs: {}, end: 40 }]))));
  assert.deepEqual(
    exemplarsOf(second as DataPoint<unknown>).map((e) => e.value),
    [2],
  );
  const [third] = pointsOf(s.attach(rmOf(sumMetric("c", [{ attrs: {}, end: 60 }]))));
  assert.deepEqual(exemplarsOf(third as DataPoint<unknown>), []);
});

test("a series joins the matching point with the most attributes and keeps the rest as filteredAttributes", () => {
  const s = store();
  s.offer({
    scope: KEY,
    instrument: "c",
    kind: "sum",
    value: 1,
    attributes: { route: "/a", method: "GET", user: "u1" },
    context: spanContext(true),
    time: at(1),
  });
  s.offer({
    scope: KEY,
    instrument: "c",
    kind: "sum",
    value: 2,
    attributes: { route: "/b", method: "GET" },
    context: spanContext(true),
    time: at(2),
  });
  const rm = s.attach(
    rmOf(
      sumMetric("c", [
        { attrs: {}, end: 10 },
        { attrs: { route: "/a" }, end: 10 },
        { attrs: { route: "/a", method: "GET" }, end: 10 },
        { attrs: { route: "/b", method: "POST" }, end: 10 },
      ]),
    ),
  );
  const [none, routeOnly, both, mismatch] = pointsOf(rm);
  assert.deepEqual(
    exemplarsOf(none as DataPoint<unknown>).map((e) => e.value),
    [2],
  );
  assert.deepEqual(exemplarsOf(routeOnly as DataPoint<unknown>), []);
  assert.deepEqual(exemplarsOf(both as DataPoint<unknown>), [
    {
      timeUnixNano: 1_000_000n,
      value: 1,
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      filteredAttributes: { user: "u1" },
    },
  ]);
  assert.deepEqual(exemplarsOf(mismatch as DataPoint<unknown>), []);
  assert.deepEqual(exemplarsOf(none as DataPoint<unknown>)[0]?.filteredAttributes, {
    route: "/b",
    method: "GET",
  });
});

test("attach consumes: a second reader collecting the same cycle gets nothing", () => {
  const s = store();
  s.offer({
    scope: KEY,
    instrument: "c",
    kind: "sum",
    value: 1,
    attributes: {},
    context: spanContext(true),
    time: at(1),
  });
  const [first] = pointsOf(s.attach(rmOf(sumMetric("c", [{ attrs: {}, end: 5 }]))));
  const [second] = pointsOf(s.attach(rmOf(sumMetric("c", [{ attrs: {}, end: 6 }]))));
  assert.equal(exemplarsOf(first as DataPoint<unknown>).length, 1);
  assert.equal(exemplarsOf(second as DataPoint<unknown>).length, 0);
});

test("attach leaves its input untouched and an unmatched scope or instrument gets nothing", () => {
  const s = store();
  s.offer({
    scope: KEY,
    instrument: "c",
    kind: "sum",
    value: 1,
    attributes: {},
    context: spanContext(true),
    time: at(1),
  });
  const input = rmOf(sumMetric("other", [{ attrs: {}, end: 5 }]));
  const out = s.attach(input);
  assert.equal(Object.hasOwn(pointsOf(input)[0] as object, "exemplars"), false);
  assert.deepEqual(exemplarsOf(pointsOf(out)[0] as DataPoint<unknown>), []);
});

test("past maxSeries new series are dropped", () => {
  const s = store("always_on", 2);
  for (const user of ["a", "b", "c"]) {
    s.offer({
      scope: KEY,
      instrument: "c",
      kind: "sum",
      value: 1,
      attributes: { user },
      context: ROOT_CONTEXT,
      time: at(1),
    });
  }
  const [p] = pointsOf(s.attach(rmOf(sumMetric("c", [{ attrs: {}, end: 5 }]))));
  assert.equal(exemplarsOf(p as DataPoint<unknown>).length, 2);
});
