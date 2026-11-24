import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { createRecorder, type Recorder } from "./recorder.ts";

async function withRecorder(
  fn: (rec: Recorder) => Promise<void> | void,
  options: Parameters<typeof createRecorder>[0] = {},
): Promise<void> {
  const rec = await createRecorder(options);
  try {
    await fn(rec);
  } finally {
    await rec.shutdown();
  }
}

test("a recorder records spans in end order, logs and metrics, with debug on and no console", async () => {
  await withRecorder(async (rec) => {
    const tracer = rec.telemetry.tracerProvider.getTracer("app");
    const counter = rec.telemetry.meterProvider.getMeter("app").createCounter("app.jobs");
    tracer.startActiveSpan("outer", (outer) => {
      tracer.startActiveSpan("inner", (inner) => {
        rec.telemetry.logger.debug("working", { "app.step": 1 });
        counter.add(2);
        inner.end();
      });
      outer.end();
    });
    assert.deepEqual(
      rec.spans().map((s) => s.name),
      ["inner", "outer"],
    );
    const [log] = rec.logs();
    assert.equal(rec.logs().length, 1);
    assert.equal(log?.body, "working");
    assert.equal(log?.level, "debug");
    assert.equal(log?.severityNumber, 5);
    assert.deepEqual(log?.attributes, { "app.step": 1 });
    assert.equal(log?.traceId, rec.spans()[0]?.spanContext().traceId);
    assert.equal(log?.spanId, rec.spans()[0]?.spanContext().spanId);
    assert.equal(log?.eventName, undefined);
    assert.ok((await rec.metricNames()).includes("app.jobs"));
    assert.equal(rec.telemetry.resource.attributes["service.name"], "test");
    assert.equal(rec.telemetry.resource.attributes["deployment.environment.name"], "test");
  });
});

test("spans are recorded already redacted, and logs already classified", async () => {
  await withRecorder(async (rec) => {
    const span = rec.telemetry.tracerProvider.getTracer("app").startSpan("op");
    span.setAttribute("http.request.header.authorization", "Bearer x");
    span.setAttribute("app.ok", true);
    span.end();
    rec.telemetry.logger.info("hi", { "http.request.header.authorization": "Bearer x", "app.ok": true });
    assert.deepEqual(rec.spans()[0]?.attributes, { "app.ok": true });
    assert.deepEqual(rec.logs()[0]?.attributes, { "app.ok": true });
  });
});

test("an event's name is recorded as eventName", async () => {
  await withRecorder(async (rec) => {
    rec.telemetry.event("app.thing.done", { "app.n": 3 });
    const [log] = rec.logs();
    assert.equal(log?.eventName, "app.thing.done");
    assert.equal(log?.level, "info");
  });
});

test("exemplars carry the trace of the span the measurement ran in", async () => {
  await withRecorder(async (rec) => {
    const histogram = rec.telemetry.meterProvider.getMeter("app").createHistogram("app.latency");
    let traceId = "";
    let spanId = "";
    rec.telemetry.tracerProvider.getTracer("app").startActiveSpan("op", (span) => {
      traceId = span.spanContext().traceId;
      spanId = span.spanContext().spanId;
      histogram.record(0.25, { "app.route": "/x" });
      span.end();
    });
    histogram.record(1, { "app.route": "/x" });
    const exemplars = await rec.exemplars("app.latency");
    assert.equal(exemplars.length, 1);
    assert.equal(exemplars[0]?.traceId, traceId);
    assert.equal(exemplars[0]?.spanId, spanId);
    assert.equal(exemplars[0]?.value, 0.25);
    assert.deepEqual(exemplars[0]?.filteredAttributes, {});
    // A collection consumes the store's samples; the recorder keeps what earlier collections saw.
    assert.equal((await rec.exemplars("app.latency")).length, 1);
    assert.deepEqual(await rec.exemplars("app.none"), []);
  });
});

test("two recorders are isolated", async () => {
  const a = await createRecorder({ serviceName: "a" });
  const b = await createRecorder({ serviceName: "b" });
  try {
    a.telemetry.tracerProvider.getTracer("t").startSpan("only-a").end();
    a.telemetry.logger.info("only-a");
    a.telemetry.meterProvider.getMeter("t").createCounter("only.a").add(1);
    assert.equal(a.spans().length, 1);
    assert.equal(b.spans().length, 0);
    assert.equal(b.logs().length, 0);
    assert.ok(!(await b.metricNames()).includes("only.a"));
    assert.equal(a.telemetry.resource.attributes["service.name"], "a");
    assert.equal(b.telemetry.resource.attributes["service.name"], "b");
  } finally {
    await Promise.all([a.shutdown(), b.shutdown()]);
  }
});

test("ambient OTEL_* variables are ignored", async () => {
  const saved = { sampler: process.env.OTEL_TRACES_SAMPLER, name: process.env.OTEL_SERVICE_NAME };
  process.env.OTEL_TRACES_SAMPLER = "always_off";
  process.env.OTEL_SERVICE_NAME = "x";
  try {
    await withRecorder((rec) => {
      rec.telemetry.tracerProvider.getTracer("t").startSpan("sampled").end();
      assert.equal(rec.spans().length, 1);
      assert.equal(rec.telemetry.resource.attributes["service.name"], "test");
    });
  } finally {
    if (saved.sampler === undefined) delete process.env.OTEL_TRACES_SAMPLER;
    else process.env.OTEL_TRACES_SAMPLER = saved.sampler;
    if (saved.name === undefined) delete process.env.OTEL_SERVICE_NAME;
    else process.env.OTEL_SERVICE_NAME = saved.name;
  }
});

test("caller options win over the defaults, but never replace the injected exporters", async () => {
  await withRecorder(
    (rec) => {
      rec.telemetry.logger.debug("dropped");
      rec.telemetry.logger.warn("kept");
      assert.deepEqual(
        rec.logs().map((l) => l.body),
        ["kept"],
      );
      assert.equal(rec.telemetry.resource.attributes["service.name"], "svc");
      assert.equal(rec.telemetry.resource.attributes["deployment.environment.name"], "staging");
      rec.telemetry.tracerProvider.getTracer("t").startSpan("s").end();
      assert.equal(rec.spans().length, 1);
    },
    {
      serviceName: "svc",
      environment: "staging",
      logLevel: "warn",
      // A JavaScript caller can pass these despite the type; the recorder keeps its own.
      ...({ spanProcessor: undefined, hermetic: false } as object),
    },
  );
});

test("a context manager is installed, so active spans propagate", async () => {
  await withRecorder((rec) => {
    const span = rec.telemetry.tracerProvider.getTracer("t").startSpan("s");
    const ctx = trace.setSpan(ROOT_CONTEXT, span);
    assert.equal(
      context.with(ctx, () => context.active()),
      ctx,
    );
    span.end();
  });
});

const CONTEXT_CHILD = fileURLToPath(new URL("./test-support/context-child.ts", import.meta.url));

/** Runs a context-manager scenario in a fresh process of this runtime, which starts with no manager. */
function contextScenario(scenario: string): Promise<Record<string, boolean>> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CONTEXT_CHILD, scenario], { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err !== null) {
        reject(new Error(`${scenario} failed: ${err.message}\n${stdout}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, boolean>);
    });
  });
}

test("the manager a recorder installs is removed when the last recorder shuts down, in either order", async () => {
  const want = { before: false, both: true, afterFirst: true, afterLast: false };
  assert.deepEqual(await contextScenario("ordered"), want);
  assert.deepEqual(await contextScenario("reversed"), want);
});

test("a context manager registered before any recorder is never touched", async () => {
  assert.deepEqual(await contextScenario("preexisting"), { stillGlobal: true, afterLast: true });
});

test("a recorder leaves a manager someone else installed after it alone", async () => {
  assert.deepEqual(await contextScenario("replaced"), { stillGlobal: true, afterLast: true });
});

test("a recorder after the last one shut down installs a manager again", async () => {
  assert.deepEqual(await contextScenario("again"), { afterFirst: false, again: true, afterLast: false });
});

test("shutdown flushes, keeps what was recorded and is idempotent", async () => {
  const rec = await createRecorder();
  rec.telemetry.tracerProvider.getTracer("t").startSpan("s").end();
  rec.telemetry.logger.info("bye");
  await rec.shutdown();
  await rec.shutdown();
  assert.equal(rec.spans().length, 1);
  assert.equal(rec.logs().length, 1);
  await assert.rejects(rec.metrics(), /o11ytest: collecting metrics/);
});

test("logExport false cannot turn off the recorder's log capture", async () => {
  await withRecorder(
    async (rec) => {
      rec.telemetry.logger.info("leak", { "http.request.header.authorization": "Bearer x" });
      assert.equal(rec.logs().length, 1);
      await assert.rejects(rec.assertConforms(), /secret-classified attributes on logs/);
    },
    { ...({ logExport: false } as object) },
  );
});
