import assert, { AssertionError } from "node:assert/strict";
import { test } from "node:test";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { checkEvent, conformanceProblems, correlationProblems, fail, leafKeys } from "./assertions.ts";
import { createRecorder, type Recorder, type RecorderOptions } from "./recorder.ts";

async function withRecorder(fn: (rec: Recorder) => Promise<void> | void, options: RecorderOptions = {}) {
  const rec = await createRecorder(options);
  try {
    await fn(rec);
  } finally {
    await rec.shutdown();
  }
}

function failsWith(message: string): (err: unknown) => boolean {
  return (err: unknown) => {
    assert.ok(err instanceof AssertionError, `want AssertionError, got ${String(err)}`);
    assert.equal(err.message, message);
    return true;
  };
}

// cleanFlow records a span with a correlated log, a complete event and an exemplar on app.latency.
function cleanFlow(rec: Recorder): void {
  const histogram = rec.telemetry.meterProvider.getMeter("app").createHistogram("app.latency");
  rec.telemetry.tracerProvider.getTracer("app").startActiveSpan("GET /items", (span) => {
    span.setAttribute("http.request.method", "GET");
    rec.telemetry.logger.info("listing items", { "app.count": 3 });
    rec.telemetry.event("o11y.telemetry.dropped", { "o11y.signal": "logs", "error.type": "Error" });
    histogram.record(0.5);
    span.end();
  });
}

test("a clean flow conforms, is correlated and closes the triangle", async () => {
  await withRecorder(async (rec) => {
    cleanFlow(rec);
    await rec.assertConforms();
    rec.assertCorrelated();
    await rec.assertTriangle({ metric: "app.latency" });
  });
});

test("assertConforms reports a secret the code under test put on a log record", async () => {
  await withRecorder(async (rec) => {
    rec.telemetry.logger.info("login", { "http.request.header.authorization": "Bearer x" });
    await assert.rejects(
      rec.assertConforms(),
      failsWith(
        "o11ytest: the code under test emitted secret-classified attributes on logs (1 redaction(s) counted); " +
          "they were redacted, but secrets must never be emitted",
      ),
    );
  });
});

test("assertConforms reports a secret the code under test put on a span", async () => {
  await withRecorder(async (rec) => {
    const span = rec.telemetry.tracerProvider.getTracer("app").startSpan("op");
    span.setAttribute("http.request.header.cookie", "sid=1");
    span.end();
    await assert.rejects(
      rec.assertConforms(),
      failsWith(
        "o11ytest: the code under test emitted secret-classified attributes on traces (1 redaction(s) counted); " +
          "they were redacted, but secrets must never be emitted",
      ),
    );
  });
});

test("assertConforms reports a secret the recorder options put on the resource, distinctly", async () => {
  await withRecorder(
    async (rec) => {
      await assert.rejects(
        rec.assertConforms(),
        failsWith(
          "o11ytest: options passed to createRecorder put a secret-classified attribute on the resource " +
            "(1 redaction(s) counted); it was redacted, but secrets must never be emitted",
        ),
      );
    },
    { resourceAttributes: { "http.request.header.authorization": "Bearer x" } },
  );
});

test("assertConforms reports an event missing a required attribute and a required template", async () => {
  await withRecorder(async (rec) => {
    rec.telemetry.event("o11y.telemetry.dropped", { "o11y.signal": "logs" });
    rec.telemetry.event("o11y.telemetry.configured", { "app.other": 1 });
    await assert.rejects(
      rec.assertConforms(),
      failsWith(
        "o11ytest: event o11y.telemetry.dropped: missing required attribute error.type\n" +
          "o11ytest: event o11y.telemetry.configured: missing required template attribute o11y.config.<key>",
      ),
    );
  });
});

test("a template is satisfied through a nested group, and unregistered events pass", async () => {
  await withRecorder(async (rec) => {
    rec.telemetry.event("o11y.telemetry.configured", { o11y: { config: { sampler: "always_on" } } });
    rec.telemetry.event("app.unregistered", {});
    await rec.assertConforms();
  });
});

test("conformanceProblems reports a missing tier-0 key and secrets in the clear", () => {
  const resource = {
    "service.name": "svc",
    "service.version": "1",
    "deployment.environment.name": "test",
    "telemetry.sdk.name": "opentelemetry",
    "telemetry.sdk.language": "nodejs",
  };
  const span = { name: "op", attributes: { "http.request.header.cookie": "sid=1", "app.ok": 1 } };
  const problems = conformanceProblems({
    resource,
    logs: [
      {
        body: "leak",
        level: "info",
        severityNumber: 9,
        attributes: { http: { request: { header: { authorization: "Bearer x" } } } },
      },
    ],
    spans: [span as unknown as ReadableSpan],
  });
  assert.deepEqual(problems, [
    'o11ytest: resource missing required tier-0 attribute "telemetry.sdk.version"',
    'o11ytest: log record "leak" carries secret-classified attribute "http.request.header.authorization" in the clear',
    'o11ytest: span "op" carries secret-classified attribute "http.request.header.cookie" in the clear',
  ]);
});

test("checkEvent matches Go's CheckEvent: a bare template prefix does not satisfy it", () => {
  assert.deepEqual(checkEvent("o11y.telemetry.configured", ["o11y.config."]), [
    "event o11y.telemetry.configured: missing required template attribute o11y.config.<key>",
  ]);
  assert.deepEqual(checkEvent("o11y.telemetry.configured", ["o11y.config.x"]), []);
  assert.deepEqual(checkEvent("app.unregistered", []), []);
  assert.deepEqual(checkEvent("o11y.request.summary", ["o11y.outcome", "http.request.method"]), [
    "event o11y.request.summary: missing required attribute http.response.status_code",
    "event o11y.request.summary: missing required attribute o11y.duration",
  ]);
});

test("leafKeys joins groups with dots, inlines an empty key and keeps arrays and bytes as leaves", () => {
  assert.deepEqual(leafKeys({ a: 1, g: { b: [1, 2], "": { c: true }, d: new Uint8Array(1) } }), [
    "a",
    "g.b",
    "g.c",
    "g.d",
  ]);
});

test("assertCorrelated reports a record without its span's trace ID, or with another one", () => {
  const active = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", traceFlags: 1 };
  const log = { body: "x", level: "info", severityNumber: 9, attributes: {} } as const;
  assert.deepEqual(
    correlationProblems([
      { log, active },
      { log: { ...log, body: "y", traceId: "11111111111111111111111111111111" }, active },
      { log: { ...log, body: "z" }, active: undefined },
      { log: { ...log, body: "ok", traceId: active.traceId, spanId: active.spanId }, active },
    ]),
    [
      'o11ytest: correlated record "x" has no trace ID',
      'o11ytest: record "y" trace ID "11111111111111111111111111111111" does not match its span ' +
        '"0af7651916cd43dd8448eb211c80319c"',
    ],
  );
});

test("fail throws one AssertionError carrying every problem", () => {
  assert.throws(() => fail(["one", "two"]), failsWith("one\ntwo"));
});

test("assertTriangle reports a missing span", async () => {
  await withRecorder(async (rec) => {
    rec.telemetry.logger.info("alone");
    await assert.rejects(
      rec.assertTriangle({ metric: "app.latency" }),
      failsWith("o11ytest: triangle: no span was recorded"),
    );
  });
});

test("assertTriangle reports a span with no log carrying its IDs", async () => {
  await withRecorder(async (rec) => {
    rec.telemetry.tracerProvider.getTracer("app").startSpan("op").end();
    rec.telemetry.logger.info("outside");
    await assert.rejects(
      rec.assertTriangle({ metric: "app.latency" }),
      failsWith(
        "o11ytest: triangle: none of 1 log record(s) carries the trace and span IDs of one of 1 recorded span(s)",
      ),
    );
  });
});

test("assertTriangle reports a metric with no exemplar, or none on the correlated trace", async () => {
  await withRecorder(async (rec) => {
    const histogram = rec.telemetry.meterProvider.getMeter("app").createHistogram("app.latency");
    rec.telemetry.tracerProvider.getTracer("app").startActiveSpan("op", (span) => {
      rec.telemetry.logger.info("inside");
      span.end();
    });
    histogram.record(1);
    await assert.rejects(
      rec.assertTriangle({ metric: "app.latency" }),
      failsWith('o11ytest: triangle: no exemplar recorded on "app.latency"'),
    );
    rec.telemetry.tracerProvider.getTracer("app").startActiveSpan("other", (span) => {
      histogram.record(2);
      span.end();
    });
    await assert.rejects(
      rec.assertTriangle({ metric: "app.latency" }),
      failsWith(
        'o11ytest: triangle: none of 1 exemplar(s) on "app.latency" carries the trace ID of a span ' +
          "with a correlated log record",
      ),
    );
  });
});
