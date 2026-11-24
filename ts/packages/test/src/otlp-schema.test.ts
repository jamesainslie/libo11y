import assert from "node:assert/strict";
import { test } from "node:test";
import { OtlpJsonMetricsSerializer } from "@libo11y/core";
import { createTraceState, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  JsonLogsSerializer,
  JsonMetricsSerializer,
  JsonTraceSerializer,
  ProtobufLogsSerializer,
  ProtobufMetricsSerializer,
  ProtobufTraceSerializer,
} from "@opentelemetry/otlp-transformer";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { AggregationType } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { decodeOtlpProtobuf, normalizeOtlp } from "./otlp-schema.ts";
import { createRecorder, type Recorder } from "./recorder.ts";
import { ProtoWriter } from "./test-support/proto-writer.ts";

const PARENT = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: 1,
  isRemote: true,
  traceState: createTraceState("vendor=a,other=b"),
};

function json(bytes: Uint8Array | undefined): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function withRecorder(fn: (rec: Recorder) => Promise<void>): Promise<void> {
  const rec = await createRecorder({
    views: [{ instrumentName: "app.exp", aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM } }],
  });
  try {
    await fn(rec);
  } finally {
    await rec.shutdown();
  }
}

function recordSpans(rec: Recorder): readonly ReadableSpan[] {
  const tracer = rec.telemetry.tracerProvider.getTracer("app", "1.2.3");
  const parent = trace.setSpanContext(ROOT_CONTEXT, PARENT);
  const span = tracer.startSpan(
    "GET /items",
    {
      kind: SpanKind.SERVER,
      attributes: {
        "app.s": "x",
        "app.n": 7,
        "app.neg": -42,
        "app.big": 2 ** 40,
        "app.d": 1.5,
        "app.b": true,
        "app.list": ["a", "b"],
        "app.nums": [1, 2.5],
      },
      links: [{ context: { ...PARENT, spanId: "00f067aa0ba902b7" }, attributes: { "app.why": "batch" } }],
    },
    parent,
  );
  span.addEvent("retry", { "app.attempt": 2 });
  span.setStatus({ code: SpanStatusCode.ERROR, message: "boom" });
  span.end();
  tracer.startSpan("internal").end();
  rec.telemetry.tracerProvider.getTracer("other").startSpan("root", { kind: SpanKind.CLIENT }).end();
  return rec.spans();
}

test("protobuf traces from upstream decode to the upstream JSON object", async () => {
  await withRecorder(async (rec) => {
    const spans = recordSpans(rec) as ReadableSpan[];
    const decoded = decodeOtlpProtobuf(
      "traces",
      ProtobufTraceSerializer.serializeRequest(spans) as Uint8Array,
    );
    const expected = json(JsonTraceSerializer.serializeRequest(spans));
    assert.deepEqual(normalizeOtlp(decoded), normalizeOtlp(expected));
    // The decoding is not vacuous: IDs, times and nested values survive.
    const [rs] = decoded.resourceSpans as { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    const first = rs?.scopeSpans[0]?.spans[0];
    assert.equal(first?.parentSpanId, PARENT.spanId);
    assert.equal(first?.traceId, PARENT.traceId);
    assert.equal(first?.traceState, "vendor=a,other=b");
    assert.match(String(first?.startTimeUnixNano), /^\d{19}$/);
    assert.equal(first?.kind, 2);
    assert.equal(first?.flags, 0x301);
  });
});

test("protobuf metrics from upstream decode to the upstream JSON object", async () => {
  await withRecorder(async (rec) => {
    const meter = rec.telemetry.meterProvider.getMeter("app", "1.0.0");
    meter.createCounter("app.jobs", { unit: "{job}", description: "Jobs." }).add(3, { "app.kind": "a" });
    meter.createUpDownCounter("app.queue").add(-2.5);
    meter.createHistogram("app.latency", { unit: "s" }).record(0.2);
    meter.createHistogram("app.size", { advice: { explicitBucketBoundaries: [] } }).record(4);
    const exp = meter.createHistogram("app.exp");
    for (const v of [0, 0.001, 3, 250, -7]) exp.record(v);
    meter.createGauge("app.temp").record(21.5);
    meter.createObservableGauge("app.int.gauge", { valueType: 1 }).addCallback((r) => r.observe(9));
    const rm = await rec.metrics();
    const decoded = decodeOtlpProtobuf(
      "metrics",
      ProtobufMetricsSerializer.serializeRequest(rm) as Uint8Array,
    );
    assert.deepEqual(normalizeOtlp(decoded), normalizeOtlp(json(JsonMetricsSerializer.serializeRequest(rm))));
    const names = JSON.stringify(decoded);
    for (const n of ["app.jobs", "app.queue", "app.latency", "app.exp", "app.temp", "exponentialHistogram"]) {
      assert.ok(names.includes(n), n);
    }
  });
});

test("protobuf logs from upstream decode to the upstream JSON object", async () => {
  await withRecorder(async (rec) => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      resource: rec.telemetry.resource,
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    const logger = provider.getLogger("bridge", "0.1.0");
    logger.emit({
      severityNumber: 9,
      severityText: "INFO",
      body: "hello",
      eventName: "app.thing",
      attributes: {
        "app.s": "x",
        "app.n": -3,
        "app.d": 0.5,
        "app.b": false,
        "app.bytes": new Uint8Array([0, 1, 254, 255]),
        "app.list": [1, "two", true],
        "app.map": { k: "v", inner: { deep: 1 } },
      },
      context: trace.setSpanContext(ROOT_CONTEXT, PARENT),
    });
    logger.emit({ body: { structured: ["a", 1] } });
    logger.emit({ severityNumber: 17 });
    const records = exporter.getFinishedLogRecords() as ReadableLogRecord[];
    const decoded = decodeOtlpProtobuf(
      "logs",
      ProtobufLogsSerializer.serializeRequest(records) as Uint8Array,
    );
    assert.deepEqual(
      normalizeOtlp(decoded),
      normalizeOtlp(json(JsonLogsSerializer.serializeRequest(records))),
    );
    assert.ok(JSON.stringify(decoded).includes('"bytesValue":"AAH+/w=="'));
    await provider.shutdown();
  });
});

test("core's JSON metrics with exemplars keep their exemplars through normalization", async () => {
  await withRecorder(async (rec) => {
    const histogram = rec.telemetry.meterProvider.getMeter("app").createHistogram("app.latency");
    rec.telemetry.tracerProvider.getTracer("app").startActiveSpan("op", (span) => {
      histogram.record(0.5, { "app.route": "/x" });
      span.end();
    });
    const object = json(OtlpJsonMetricsSerializer.serializeRequest(await rec.metrics()));
    const text = JSON.stringify(normalizeOtlp(object));
    assert.match(
      text,
      /"exemplars":\[\{"timeUnixNano":"\d+","asDouble":0\.5,"spanId":"[0-9a-f]{16}","traceId":"[0-9a-f]{32}"\}\]/,
    );
  });
});

// exemplar writes an Exemplar message: time, a value, IDs and one filtered attribute.
function exemplar(w: ProtoWriter, value: { double: number } | { int: bigint }): void {
  w.message((e) => {
    e.tag(7, 2).message((kv) => {
      kv.tag(1, 2).string("app.user");
      kv.tag(2, 2).message((v) => v.tag(1, 2).string("u1"));
    });
    e.tag(2, 1).fixed64(1_700_000_000_000_000_001n);
    if ("double" in value) e.tag(3, 1).double(value.double);
    else e.tag(6, 1).fixed64(value.int);
    e.tag(4, 2).bytes(Uint8Array.from([0xb7, 0xad, 0x6b, 0x71, 0x69, 0x20, 0x33, 0x31]));
    e.tag(5, 2).bytes(Uint8Array.from(Buffer.from(PARENT.traceId, "hex")));
  });
}

test("exemplars decode on number (5), histogram (8) and exponential histogram (11) points", () => {
  const w = new ProtoWriter();
  w.tag(1, 2).message((rm) =>
    rm.tag(2, 2).message((sm) => {
      sm.tag(2, 2).message((m) => {
        m.tag(1, 2).string("sum");
        m.tag(7, 2).message((sum) => sum.tag(1, 2).message((p) => exemplar(p.tag(5, 2), { int: -4n })));
      });
      sm.tag(2, 2).message((m) => {
        m.tag(1, 2).string("hist");
        m.tag(9, 2).message((h) => h.tag(1, 2).message((p) => exemplar(p.tag(8, 2), { double: 0.25 })));
      });
      sm.tag(2, 2).message((m) => {
        m.tag(1, 2).string("exp");
        m.tag(10, 2).message((h) => h.tag(1, 2).message((p) => exemplar(p.tag(11, 2), { double: 2 })));
      });
    }),
  );
  const decoded = decodeOtlpProtobuf("metrics", w.finish()) as {
    resourceMetrics: {
      scopeMetrics: { metrics: Record<string, { dataPoints: { exemplars: unknown[] }[] }>[] }[];
    }[];
  };
  const metrics = decoded.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
  const base = {
    filteredAttributes: [{ key: "app.user", value: { stringValue: "u1" } }],
    timeUnixNano: "1700000000000000001",
    spanId: "b7ad6b7169203331",
    traceId: PARENT.traceId,
  };
  assert.deepEqual(metrics[0]?.sum?.dataPoints[0]?.exemplars, [{ ...base, asInt: -4 }]);
  assert.deepEqual(metrics[1]?.histogram?.dataPoints[0]?.exemplars, [{ ...base, asDouble: 0.25 }]);
  assert.deepEqual(metrics[2]?.exponentialHistogram?.dataPoints[0]?.exemplars, [{ ...base, asDouble: 2 }]);
});

test("normalizeOtlp drops proto3 defaults and empties, and a resource's schemaUrl, but keeps list zeros", () => {
  assert.deepEqual(
    normalizeOtlp({
      resource: { attributes: [], droppedAttributesCount: 0, schemaUrl: "https://x" },
      schemaUrl: "https://x",
      a: { b: { c: "" } },
      counts: [0, 1],
      on: false,
      kept: { flag: true, n: 2 },
      gone: undefined,
    }),
    { schemaUrl: "https://x", counts: [0, 1], kept: { flag: true, n: 2 } },
  );
});

test("normalizeOtlp keeps zero values of oneof and optional members", () => {
  for (const value of [
    { intValue: 0 },
    { boolValue: false },
    { stringValue: "" },
    { doubleValue: 0 },
    { bytesValue: "" },
  ]) {
    assert.deepEqual(normalizeOtlp({ key: "k", value }), { key: "k", value });
  }
  assert.deepEqual(normalizeOtlp({ arrayValue: {} }), { arrayValue: {} });
  assert.deepEqual(normalizeOtlp({ dataPoints: [{ asInt: 0, timeUnixNano: "1" }] }), {
    dataPoints: [{ asInt: 0, timeUnixNano: "1" }],
  });
  assert.deepEqual(normalizeOtlp({ exemplars: [{ asDouble: 0, spanId: "" }] }), {
    exemplars: [{ asDouble: 0 }],
  });
  // HistogramDataPoint and ExponentialHistogramDataPoint sum, min and max are proto3 optional.
  assert.deepEqual(normalizeOtlp({ sum: 0, min: 0, max: 0, count: 0 }), { sum: 0, min: 0, max: 0 });
  assert.deepEqual(normalizeOtlp({ name: "m", gauge: {} }), { name: "m", gauge: {} });
});

test("a zero int attribute survives the protobuf and JSON round trip distinctly from an absent value", async () => {
  await withRecorder(async (rec) => {
    const span = rec.telemetry.tracerProvider.getTracer("app").startSpan("op", {
      attributes: { "app.zero": 0, "app.no": false, "app.empty": "" },
    });
    span.end();
    const spans = rec.spans() as ReadableSpan[];
    const decoded = normalizeOtlp(
      decodeOtlpProtobuf("traces", ProtobufTraceSerializer.serializeRequest(spans) as Uint8Array),
    );
    assert.deepEqual(decoded, normalizeOtlp(json(JsonTraceSerializer.serializeRequest(spans))));
    const text = JSON.stringify(decoded);
    assert.ok(text.includes('{"key":"app.zero","value":{"intValue":0}}'), text);
    assert.ok(text.includes('{"key":"app.no","value":{"boolValue":false}}'), text);
    assert.ok(text.includes('{"key":"app.empty","value":{"stringValue":""}}'), text);
  });
});
