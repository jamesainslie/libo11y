/**
 * Revocation end to end: the real consent controller, delivery, exporters and core over a
 * transport that records every request, so the tests see exactly what would reach a collector.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { exemplarStoreOf } from "@libo11y/core/testing";
import { context, trace } from "@opentelemetry/api";
import type { SendRequest } from "./contracts/transport.ts";
import type { WebSetupOptions, WebTelemetry } from "./options.ts";
import { defaultSetupDeps, type SetupDeps, setupWithDeps } from "./setup.ts";
import { createFakeQueue, createFakeTransport } from "./test-support/index.ts";

const OPTIONS: WebSetupOptions = {
  serviceName: "shop",
  environment: "test",
  // Not hermetic, which routes every signal to "none"; env is empty, so only these options count.
  hermetic: false,
  env: {},
  endpoint: "https://collector.example",
  consent: { initial: "granted" },
  instrumentations: { fetch: false, xhr: false, documentLoad: false },
};

interface Collector {
  readonly requests: SendRequest[];
}

function deps(collector: Collector): SetupDeps {
  return {
    ...defaultSetupDeps(),
    openQueue: async () => createFakeQueue(),
    createHttpTransport: () => {
      const t = createFakeTransport();
      return {
        send: (req) => {
          collector.requests.push(req);
          return t.send(req);
        },
      };
    },
    document: undefined,
    window: undefined,
  };
}

async function start(
  extra: Partial<WebSetupOptions> = {},
): Promise<{ web: WebTelemetry; collector: Collector }> {
  const collector: Collector = { requests: [] };
  const web = await setupWithDeps({ ...OPTIONS, ...extra }, deps(collector), false);
  return { web, collector };
}

type Json = Record<string, unknown>;
const bodies = (c: Collector, signal: string): Json[] =>
  c.requests.filter((r) => r.signal === signal).map((r) => JSON.parse(r.body) as Json);

function spanNames(c: Collector): string[] {
  return bodies(c, "traces").flatMap((b) =>
    (b.resourceSpans as Json[]).flatMap((rs) =>
      (rs.scopeSpans as Json[]).flatMap((ss) => (ss.spans as Json[]).map((s) => s.name as string)),
    ),
  );
}

function logBodies(c: Collector): string[] {
  return bodies(c, "logs").flatMap((b) =>
    (b.resourceLogs as Json[]).flatMap((rl) =>
      (rl.scopeLogs as Json[]).flatMap((sl) =>
        (sl.logRecords as Json[]).map(
          (r) => (r.body as { stringValue?: string } | undefined)?.stringValue ?? "",
        ),
      ),
    ),
  );
}

interface Point {
  readonly metric: string;
  readonly attrs: Record<string, unknown>;
  readonly raw: Json;
}

function points(c: Collector, name: string): Point[] {
  return bodies(c, "metrics").flatMap((b) =>
    (b.resourceMetrics as Json[]).flatMap((rm) =>
      (rm.scopeMetrics as Json[]).flatMap((sm) =>
        (sm.metrics as Json[])
          .filter((m) => m.name === name)
          .flatMap((m) => {
            const data = (m.sum ?? m.gauge ?? m.histogram) as { dataPoints: Json[] };
            return data.dataPoints.map((p) => ({
              metric: m.name as string,
              attrs: Object.fromEntries(
                ((p.attributes as Json[] | undefined) ?? []).map((a) => [
                  a.key as string,
                  Object.values(a.value as Json)[0],
                ]),
              ),
              raw: p,
            }));
          }),
      ),
    ),
  );
}

function value(p: Point): number {
  return Number(p.raw.asInt ?? p.raw.asDouble);
}

function nanos(v: unknown): bigint {
  return BigInt(String(v));
}

test("an immediate regrant exports no span, log record or metric point from before the revoke", async () => {
  const { web, collector } = await start();
  try {
    const tracer = web.tracerProvider.getTracer("t");
    const meter = web.meterProvider.getMeter("m");
    const counter = meter.createCounter("pre.counter");
    const histogram = meter.createHistogram("pre.histogram");
    const gauge = meter.createGauge("pre.gauge");
    tracer.startSpan("pre-revoke").end();
    web.logger.info("pre-revoke");
    counter.add(5, { k: "a" });
    histogram.record(5);
    gauge.record(3);

    const revoked = web.consent.revoke();
    assert.equal(web.consent.grant(), "granted");
    await revoked;
    await web.forceFlush();

    assert.deepEqual(spanNames(collector), []);
    assert.ok(!logBodies(collector).includes("pre-revoke"), "the log record was dropped");
    for (const name of ["pre.counter", "pre.histogram", "pre.gauge"]) {
      assert.deepEqual(points(collector, name), [], name);
    }
  } finally {
    await web.shutdown();
  }
});

test("a regrant after an awaited revoke, with no new measurement, exports no metric point", async () => {
  const { web, collector } = await start();
  try {
    const meter = web.meterProvider.getMeter("m");
    meter.createCounter("c").add(5, { k: "a" });
    meter.createUpDownCounter("u").add(4);
    meter.createHistogram("h").record(5);
    meter.createGauge("g").record(3);
    await web.forceFlush();
    assert.equal(value(points(collector, "c")[0] as Point), 5, "exported while granted");
    collector.requests.length = 0;

    await web.consent.revoke();
    web.consent.grant();
    await web.forceFlush();
    for (const name of ["c", "u", "h", "g"]) assert.deepEqual(points(collector, name), [], name);
  } finally {
    await web.shutdown();
  }
});

test("after a regrant only the amounts recorded since are exported, from the boundary on", async () => {
  const { web, collector } = await start();
  try {
    const meter = web.meterProvider.getMeter("m");
    const counter = meter.createCounter("c");
    const updown = meter.createUpDownCounter("u");
    const histogram = meter.createHistogram("h");
    const gauge = meter.createGauge("g");
    counter.add(5, { k: "a" });
    counter.add(7, { k: "old" });
    updown.add(4);
    histogram.record(5);
    histogram.record(50);
    gauge.record(3, { k: "a" });
    gauge.record(9, { k: "old" });

    const before = BigInt(Date.now()) * 1_000_000n;
    await web.consent.revoke();
    web.consent.grant();
    counter.add(2, { k: "a" });
    updown.add(-1);
    histogram.record(7);
    gauge.record(4, { k: "a" });
    await web.forceFlush();

    const c = points(collector, "c");
    assert.deepEqual(
      c.map((p) => [p.attrs, value(p)]),
      [[{ k: "a" }, 2]],
      "a series with no measurement since the boundary is left out",
    );
    assert.ok(nanos(c[0]?.raw.startTimeUnixNano) >= before, "the point starts at the boundary");
    assert.deepEqual(
      points(collector, "u").map((p) => value(p)),
      [-1],
    );
    const h = points(collector, "h");
    assert.equal(h.length, 1);
    assert.equal(Number(h[0]?.raw.count), 1);
    assert.equal(h[0]?.raw.sum, 7);
    assert.equal(h[0]?.raw.min, undefined, "min is not known for a difference");
    assert.equal(h[0]?.raw.max, undefined, "max is not known for a difference");
    const buckets = ((h[0]?.raw.bucketCounts as unknown[] | undefined) ?? []).map(Number);
    assert.equal(
      buckets.reduce((a, b) => a + b, 0),
      1,
    );
    assert.deepEqual(
      points(collector, "g").map((p) => [p.attrs, value(p)]),
      [[{ k: "a" }, 4]],
      "a gauge with no reading since the boundary is left out",
    );

    // Later exports stay cumulative from the boundary.
    collector.requests.length = 0;
    counter.add(1, { k: "a" });
    await web.forceFlush();
    assert.deepEqual(
      points(collector, "c").map((p) => value(p)),
      [3],
    );
  } finally {
    await web.shutdown();
  }
});

test("a second revocation moves the boundary", async () => {
  const { web, collector } = await start();
  try {
    const counter = web.meterProvider.getMeter("m").createCounter("c");
    counter.add(5);
    await web.consent.revoke();
    web.consent.grant();
    counter.add(2);
    await web.forceFlush();
    assert.deepEqual(
      points(collector, "c").map((p) => value(p)),
      [2],
    );

    collector.requests.length = 0;
    await web.consent.revoke();
    web.consent.grant();
    await web.forceFlush();
    assert.deepEqual(points(collector, "c"), [], "nothing new since the second boundary");
    counter.add(3);
    await web.forceFlush();
    assert.deepEqual(
      points(collector, "c").map((p) => value(p)),
      [3],
    );
  } finally {
    await web.shutdown();
  }
});

test("exemplars sampled before the revoke are not exported after it", async () => {
  const { web, collector } = await start();
  try {
    const tracer = web.tracerProvider.getTracer("t");
    const counter = web.meterProvider.getMeter("m").createCounter("c");
    let preTrace = "";
    // createTelemetry installs no context manager, so each measurement is given its span.
    const pre = tracer.startSpan("pre");
    preTrace = pre.spanContext().traceId;
    counter.add(5, {}, trace.setSpan(context.active(), pre));
    pre.end();
    assert.ok(exemplarStoreOf(web) !== undefined);

    await web.consent.revoke();
    web.consent.grant();
    let postTrace = "";
    const post = tracer.startSpan("post");
    postTrace = post.spanContext().traceId;
    counter.add(2, {}, trace.setSpan(context.active(), post));
    post.end();
    await web.forceFlush();

    const exemplars = points(collector, "c").flatMap((p) => (p.raw.exemplars as Json[] | undefined) ?? []);
    const traces = exemplars.map((e) => e.traceId);
    assert.ok(!traces.includes(preTrace), "no exemplar from before the revoke");
    assert.ok(traces.includes(postTrace), "the exemplar sampled after the grant is exported");
  } finally {
    await web.shutdown();
  }
});
