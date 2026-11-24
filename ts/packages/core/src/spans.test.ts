import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_CONTEXT, type SpanContext, TraceFlags, trace } from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type Span,
  type SpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { SensitivityPolicy, type ViolationSink } from "./policy.ts";
import { redactingSpanExporter, redactingSpanProcessor } from "./spans.ts";

class Counts implements ViolationSink {
  readonly seen: string[] = [];
  add(signal: string, rule: string, n: number): void {
    for (let i = 0; i < n; i++) this.seen.push(`${signal}/${rule}`);
  }
}

const KEY = new Uint8Array(32).fill(3);
const linked: SpanContext = {
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  traceFlags: TraceFlags.SAMPLED,
};

function emit(tp: TracerProvider): void {
  const span = tp.getTracer("t").startSpan("op", {
    attributes: { "http.request.header.authorization": "Bearer x", "host.ip": "10.0.0.1", route: "/a" },
    links: [{ context: linked, attributes: { "http.request.header.cookie": "c", why: "retry" } }],
  });
  span.addEvent("ev", { "http.response.header.set-cookie": "s", n: 1 });
  span.addEvent("plain");
  span.end();
}

test("the exporter drops secrets from the span, its events and its links", async () => {
  const counts = new Counts();
  const policy = SensitivityPolicy.create({ pii: "hash", key: KEY, registries: [] }).withRecorder(counts);
  const inner = new InMemorySpanExporter();
  const tp = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: redactingSpanExporter(inner, policy) })],
  });
  emit(tp);
  await tp.forceFlush();
  const [span] = inner.getFinishedSpans();
  assert.ok(span);
  assert.deepEqual(span.attributes, { "host.ip": policy.tokenOf("10.0.0.1"), route: "/a" });
  assert.deepEqual(span.events[0]?.attributes, { n: 1 });
  assert.equal(span.events[1]?.name, "plain");
  assert.equal(span.events[1]?.attributes, undefined);
  assert.deepEqual(span.links[0]?.attributes, { why: "retry" });
  assert.deepEqual(span.links[0]?.context, linked);
  assert.equal(span.name, "op");
  assert.equal(span.ended, true);
  assert.equal(span.spanContext().traceId.length, 32);
  assert.deepEqual(counts.seen.sort(), [
    "traces/pii_attribute",
    "traces/secret_attribute",
    "traces/secret_attribute",
    "traces/secret_attribute",
  ]);
  await tp.shutdown();
});

test("a redacted view carries every ReadableSpan member of the original", async () => {
  const policy = SensitivityPolicy.create({ pii: "drop", registries: [] });
  const inner = new InMemorySpanExporter();
  const plain = new InMemorySpanExporter();
  const tp = new TracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor({ exporter: redactingSpanExporter(inner, policy) }),
      new SimpleSpanProcessor({ exporter: plain }),
    ],
  });
  const parent = trace.setSpanContext(ROOT_CONTEXT, linked);
  tp.getTracer("t", "1.0")
    .startSpan("child", { attributes: { "host.ip": "1", a: 1 } }, parent)
    .end();
  await tp.forceFlush();
  const [view] = inner.getFinishedSpans();
  const [orig] = plain.getFinishedSpans();
  assert.ok(view && orig);
  assert.notEqual(view, orig);
  const members: (keyof ReadableSpan)[] = [
    "name",
    "kind",
    "parentSpanContext",
    "startTime",
    "endTime",
    "status",
    "duration",
    "ended",
    "resource",
    "instrumentationScope",
    "droppedAttributesCount",
    "droppedEventsCount",
    "droppedLinksCount",
  ];
  for (const m of members) assert.deepEqual(view[m], orig[m], m);
  assert.deepEqual(view.spanContext(), orig.spanContext());
  assert.deepEqual(view.attributes, { a: 1 });
  await tp.shutdown();
});

test("a span with nothing to redact is exported as is", async () => {
  const policy = SensitivityPolicy.create({ pii: "drop", registries: [] });
  const seen: ReadableSpan[] = [];
  const tp = new TracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor({
        exporter: redactingSpanExporter(
          {
            export: (spans, cb) => {
              seen.push(...spans);
              cb({ code: 0 });
            },
            shutdown: async () => {},
          },
          policy,
        ),
      }),
    ],
  });
  const span = tp.getTracer("t").startSpan("clean", { attributes: { ok: true } });
  span.end();
  await tp.forceFlush();
  assert.equal(seen[0], span);
  await tp.shutdown();
});

test("the PII token on a span equals the token on a log for the same value", async () => {
  const policy = SensitivityPolicy.create({ pii: "hash", key: KEY, registries: [] });
  const inner = new InMemorySpanExporter();
  const tp = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: redactingSpanExporter(inner, policy) })],
  });
  tp.getTracer("t")
    .startSpan("s", { attributes: { "host.ip": "10.0.0.1" } })
    .end();
  await tp.forceFlush();
  const log = policy.logAttributes({ host: { ip: "10.0.0.1" } }) as { host: { ip: string } };
  assert.equal(inner.getFinishedSpans()[0]?.attributes["host.ip"], log.host.ip);
  await tp.shutdown();
});

test("the processor passes the live span to onStart and the redacted view to onEnd", async () => {
  const counts = new Counts();
  const policy = SensitivityPolicy.create({ pii: "drop", registries: [] }).withRecorder(counts);
  const started: Span[] = [];
  const ended: ReadableSpan[] = [];
  const calls: string[] = [];
  const inner: SpanProcessor = {
    onStart: (span) => {
      started.push(span);
    },
    onEnding: () => {
      calls.push("ending");
    },
    onEnd: (span) => {
      ended.push(span);
    },
    forceFlush: async () => {
      calls.push("flush");
    },
    shutdown: async () => {
      calls.push("shutdown");
    },
  };
  const tp = new TracerProvider({ spanProcessors: [redactingSpanProcessor(inner, policy)] });
  tp.getTracer("t")
    .startSpan("s", { attributes: { "host.ip": "1", a: 1 } })
    .end();
  assert.equal(started[0]?.attributes["host.ip"], "1");
  assert.deepEqual(ended[0]?.attributes, { a: 1 });
  assert.deepEqual(counts.seen, ["traces/pii_attribute"]);
  await tp.forceFlush();
  await tp.shutdown();
  assert.ok(calls.includes("ending") && calls.includes("flush") && calls.includes("shutdown"));
});

test("with a silent processor and a counting exporter, an attribute counts once", async () => {
  const counts = new Counts();
  const policy = SensitivityPolicy.create({ pii: "drop", registries: [] }).withRecorder(counts);
  const procSeen: ReadableSpan[] = [];
  const inner = new InMemorySpanExporter();
  const tp = new TracerProvider({
    spanProcessors: [
      redactingSpanProcessor(
        {
          onStart: () => {},
          onEnd: (s) => {
            procSeen.push(s);
          },
          forceFlush: async () => {},
          shutdown: async () => {},
        },
        policy.silent(),
      ),
      new BatchSpanProcessor({ exporter: redactingSpanExporter(inner, policy) }),
    ],
  });
  tp.getTracer("t")
    .startSpan("s", { attributes: { "http.request.header.cookie": "c" } })
    .end();
  await tp.forceFlush();
  assert.deepEqual(procSeen[0]?.attributes, {});
  assert.deepEqual(inner.getFinishedSpans()[0]?.attributes, {});
  assert.deepEqual(counts.seen, ["traces/secret_attribute"]);
  await tp.shutdown();
});

test("the exporter delegates shutdown and forceFlush", async () => {
  const calls: string[] = [];
  const exp = redactingSpanExporter(
    {
      export: (_s, cb) => cb({ code: 0 }),
      shutdown: async () => {
        calls.push("shutdown");
      },
      forceFlush: async () => {
        calls.push("flush");
      },
    },
    SensitivityPolicy.create({ pii: "drop", registries: [] }),
  );
  await exp.forceFlush?.();
  await exp.shutdown();
  assert.deepEqual(calls, ["flush", "shutdown"]);
  const bare = redactingSpanExporter(
    { export: (_s, cb) => cb({ code: 0 }), shutdown: async () => {} },
    SensitivityPolicy.create({ pii: "drop", registries: [] }),
  );
  await bare.forceFlush?.();
});
