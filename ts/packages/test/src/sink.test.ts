import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { OtlpJsonMetricsSerializer } from "@libo11y/core";
import {
  JsonTraceSerializer,
  ProtobufMetricsSerializer,
  ProtobufTraceSerializer,
} from "@opentelemetry/otlp-transformer";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { normalizeOtlp } from "./otlp-schema.ts";
import { createRecorder, type Recorder } from "./recorder.ts";
import { type OtlpSink, type OtlpSinkOptions, startOtlpSink } from "./sink.ts";

async function withSink(fn: (sink: OtlpSink) => Promise<void>, opts?: OtlpSinkOptions): Promise<void> {
  const sink = await startOtlpSink(opts);
  try {
    await fn(sink);
  } finally {
    await sink.close();
  }
}

async function withRecorder(fn: (rec: Recorder) => Promise<void>): Promise<void> {
  const rec = await createRecorder();
  try {
    await fn(rec);
  } finally {
    await rec.shutdown();
  }
}

function post(
  sink: OtlpSink,
  path: string,
  body: Uint8Array,
  contentType: string,
  encoding?: string,
): Promise<Response> {
  return fetch(`${sink.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      ...(encoding === undefined ? {} : { "content-encoding": encoding }),
    },
    body,
  });
}

function someSpans(rec: Recorder): ReadableSpan[] {
  const span = rec.telemetry.tracerProvider.getTracer("app").startSpan("op", { attributes: { "app.n": 1 } });
  span.addEvent("e");
  span.end();
  return rec.spans() as ReadableSpan[];
}

test("the sink listens on 127.0.0.1 and decodes protobuf and JSON traces to the same object", async () => {
  await withRecorder(async (rec) => {
    const spans = someSpans(rec);
    await withSink(async (sink) => {
      assert.match(sink.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const proto = ProtobufTraceSerializer.serializeRequest(spans) as Uint8Array;
      const res = await post(sink, "/v1/traces", proto, "application/x-protobuf");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/x-protobuf");
      assert.equal((await res.arrayBuffer()).byteLength, 0);
      const jsonBytes = JsonTraceSerializer.serializeRequest(spans) as Uint8Array;
      const jsonRes = await post(sink, "/v1/traces", jsonBytes, "application/json; charset=utf-8");
      assert.equal(jsonRes.status, 200);
      assert.equal(jsonRes.headers.get("content-type"), "application/json");
      assert.equal(await jsonRes.text(), "");
      await sink.waitFor("traces", 2);
      const [fromProto, fromJson] = sink.traces();
      assert.deepEqual(normalizeOtlp(fromProto), normalizeOtlp(fromJson));
      assert.deepEqual(sink.requests(), [
        {
          path: "/v1/traces",
          contentType: "application/x-protobuf",
          encoding: undefined,
          bytes: proto.length,
        },
        { path: "/v1/traces", contentType: "application/json", encoding: undefined, bytes: jsonBytes.length },
      ]);
      assert.deepEqual(sink.metrics(), []);
      assert.deepEqual(sink.logs(), []);
    });
  });
});

test("gzip-encoded bodies are inflated", async () => {
  await withRecorder(async (rec) => {
    rec.telemetry.meterProvider.getMeter("app").createCounter("app.jobs").add(1);
    const rm = await rec.metrics();
    const plain = ProtobufMetricsSerializer.serializeRequest(rm) as Uint8Array;
    const zipped = gzipSync(plain);
    await withSink(async (sink) => {
      assert.equal((await post(sink, "/v1/metrics", zipped, "application/x-protobuf", "gzip")).status, 200);
      assert.equal((await post(sink, "/v1/metrics", plain, "application/x-protobuf")).status, 200);
      const [a, b] = sink.metrics();
      assert.deepEqual(a, b);
      assert.ok(JSON.stringify(a).includes("app.jobs"));
      assert.deepEqual(
        sink.requests().map((r) => [r.encoding, r.bytes]),
        [
          ["gzip", zipped.length],
          [undefined, plain.length],
        ],
      );
    });
  });
});

test("core's JSON metric serializer's exemplars round-trip through the sink", async () => {
  await withRecorder(async (rec) => {
    const histogram = rec.telemetry.meterProvider.getMeter("app").createHistogram("app.latency");
    let traceId = "";
    rec.telemetry.tracerProvider.getTracer("app").startActiveSpan("op", (span) => {
      traceId = span.spanContext().traceId;
      histogram.record(0.5);
      span.end();
    });
    const body = OtlpJsonMetricsSerializer.serializeRequest(await rec.metrics()) as Uint8Array;
    await withSink(async (sink) => {
      assert.equal((await post(sink, "/v1/metrics", gzipSync(body), "application/json", "gzip")).status, 200);
      const text = JSON.stringify(sink.metrics()[0]);
      assert.ok(text.includes(`"traceId":"${traceId}"`), text);
      assert.match(text, /"exemplars":\[\{"filteredAttributes":\[\],"timeUnixNano":"\d+","asDouble":0\.5,/);
    });
  });
});

test("a configured status answers every request, with Retry-After, and stores nothing", async () => {
  await withSink(
    async (sink) => {
      const res = await post(sink, "/v1/logs", new Uint8Array(0), "application/x-protobuf");
      assert.equal(res.status, 429);
      assert.equal(res.headers.get("retry-after"), "7");
      assert.deepEqual(sink.logs(), []);
      assert.equal(sink.requests().length, 1);
    },
    { status: 429, retryAfter: "7" },
  );
  await withSink(
    async (sink) => {
      const res = await post(sink, "/v1/traces", new Uint8Array(0), "application/json");
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), null);
      await res.arrayBuffer();
    },
    { status: 503 },
  );
});

test("an empty protobuf body is an empty request", async () => {
  await withSink(async (sink) => {
    assert.equal((await post(sink, "/v1/logs", new Uint8Array(0), "application/x-protobuf")).status, 200);
    assert.deepEqual(sink.logs(), [{}]);
  });
});

test("unknown paths, methods, content types, encodings and malformed bodies are refused", async () => {
  await withSink(async (sink) => {
    const ok = new Uint8Array(0);
    assert.equal((await post(sink, "/v1/profiles", ok, "application/x-protobuf")).status, 404);
    assert.equal((await fetch(`${sink.url}/v1/traces`)).status, 405);
    assert.equal((await post(sink, "/v1/traces", ok, "text/plain")).status, 415);
    assert.equal((await post(sink, "/v1/traces", ok, "application/json", "br")).status, 415);
    const bad = await post(sink, "/v1/traces", new TextEncoder().encode("{"), "application/json");
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /o11ytest: sink: /);
    const badProto = await post(sink, "/v1/traces", new Uint8Array([0x0a, 0x05]), "application/x-protobuf");
    assert.equal(badProto.status, 400);
    assert.deepEqual(sink.traces(), []);
  });
});

test("waitFor resolves when the count arrives and times out with a clear message", async () => {
  await withSink(async (sink) => {
    await assert.rejects(
      sink.waitFor("logs", 1, 30),
      new Error("o11ytest: sink: timed out after 30 ms waiting for 1 logs request(s); received 0"),
    );
    const waiting = sink.waitFor("logs", 2, 5000);
    await post(sink, "/v1/logs", new Uint8Array(0), "application/x-protobuf");
    await post(sink, "/v1/logs", new Uint8Array(0), "application/x-protobuf");
    await waiting;
    await sink.waitFor("logs");
  });
});

test("close is idempotent and frees the port", async () => {
  const sink = await startOtlpSink();
  await sink.close();
  await sink.close();
  await assert.rejects(fetch(`${sink.url}/v1/traces`, { method: "POST" }));
});
