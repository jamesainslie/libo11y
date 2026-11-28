/**
 * An export that the batch timer or the periodic reader starts on its own, and that fails, lands
 * outside any forceFlush or shutdown. Upstream hands it to the global error handler only, so a
 * createTelemetry handle, which installs nothing globally, lost it in silence, and setup wrote one
 * line that did not name the signal. Core now says the signal was dropped with
 * o11y.telemetry.dropped, the event shutdown emits, through the telemetry's own console sink, or
 * through its diagnostic stream when the console sink is off. A flush never reports it again.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { ExportResult } from "@opentelemetry/core";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { SpanExporter } from "@opentelemetry/sdk-trace";
import { exemplarMetricExporter } from "./exemplars.ts";
import type { TelemetryOptions } from "./options.ts";
import { createTelemetryWith, setupWith, type Telemetry } from "./telemetry.ts";
import { createTestPlatform, type TestPlatform } from "./testing.ts";

const OPTIONS: TelemetryOptions = { serviceName: "svc", serviceVersion: "1.2.3", environment: "test" };

/** Exports start as soon as something is buffered, and a metric reader collects every 20 ms. */
const FAST: Record<string, string> = { OTEL_BSP_SCHEDULE_DELAY: "1", OTEL_BLRP_SCHEDULE_DELAY: "1" };

class CollectorError extends Error {}

/** An exporter for every signal that fails each export while failing is set, and counts them. */
function refusing() {
  const state = { failing: true, exports: 0 };
  let waiting: (() => void)[] = [];
  const exporter = {
    export: (_items: unknown, cb: (result: ExportResult) => void): void => {
      state.exports++;
      cb(state.failing ? { code: 1, error: new CollectorError("Not Found: secret-host") } : { code: 0 });
      const wake = waiting;
      waiting = [];
      for (const w of wake) w();
    },
    forceFlush: async (): Promise<void> => {},
    shutdown: async (): Promise<void> => {},
  };
  /** Resolves once count exports have reported, or fails the test after 2 s. */
  const exported = async (count: number): Promise<void> => {
    const late = Date.now() + 2000;
    while (state.exports < count) {
      assert.ok(Date.now() < late, `export ${count} never happened; saw ${state.exports}`);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        setTimeout(resolve, 20);
      });
    }
  };
  return { state, exporter, exported };
}

function testPlatform(env: Record<string, string>, metricExporter?: PushMetricExporter): TestPlatform {
  return createTestPlatform({
    contextManager: () => new AsyncLocalStorageContextManager(),
    env: () => env,
    buildExporters: (req) =>
      metricExporter === undefined
        ? {}
        : {
            metricReader: new PeriodicExportingMetricReader({
              exporter: exemplarMetricExporter(metricExporter, req.exemplars),
              exportIntervalMillis: 20,
              exportTimeoutMillis: 10,
            }),
          },
  });
}

function parse(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The o11y.telemetry.dropped events the console sink wrote, as [signal, error.type]. */
function droppedOnConsole(platform: TestPlatform): [unknown, unknown][] {
  return parse(platform.lines)
    .filter((l) => l.msg === "o11y.telemetry.dropped")
    .map((l) => [l["o11y.signal"], l["error.type"]]);
}

/** The diagnostic lines that report o11y.telemetry.dropped. */
function droppedOnDiagnostics(platform: TestPlatform): string[] {
  return platform.diagnostics.filter((l) => l.includes("o11y.telemetry.dropped"));
}

/** Lets the event loop turn, so a result a callback reported has been handled. */
function turn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

test("a span export the batch timer started that fails says traces were dropped, without setup", async () => {
  const r = refusing();
  const platform = testPlatform(FAST);
  const t = await createTelemetryWith({ ...OPTIONS, spanExporter: r.exporter as SpanExporter }, platform);
  try {
    t.tracerProvider.getTracer("t").startSpan("s").end();
    await r.exported(1);
    await turn();
    assert.deepEqual(droppedOnConsole(platform), [["traces", "CollectorError"]]);
  } finally {
    await t.shutdown();
  }
});

test("a log export the batch timer started that fails says logs were dropped, without setup", async () => {
  const r = refusing();
  const platform = testPlatform(FAST);
  const t = await createTelemetryWith({ ...OPTIONS, logExporter: r.exporter as LogRecordExporter }, platform);
  try {
    t.logger.info("l");
    await r.exported(1);
    await turn();
    assert.deepEqual(droppedOnConsole(platform), [["logs", "CollectorError"]]);
    // The event goes to the console sink only, so a failing log export cannot feed itself.
    r.state.failing = false;
    await turn();
    assert.equal(r.state.exports, 1, "the dropped event was not exported as a log record");
  } finally {
    await t.shutdown();
  }
});

test("a metric export the periodic reader started that fails says metrics were dropped, without setup", async () => {
  const r = refusing();
  const platform = testPlatform({}, r.exporter as PushMetricExporter);
  const t = await createTelemetryWith(OPTIONS, platform);
  try {
    t.meterProvider.getMeter("m").createCounter("c").add(1);
    await r.exported(1);
    await turn();
    const dropped = droppedOnConsole(platform);
    assert.ok(dropped.length >= 1, "at least one periodic export failed and was reported");
    assert.deepEqual(dropped[0], ["metrics", "CollectorError"]);
  } finally {
    await t.shutdown();
  }
});

test("under setup, a span export the batch timer started that fails says traces were dropped", async () => {
  const r = refusing();
  const platform = testPlatform(FAST);
  const t = await setupWith({ ...OPTIONS, spanExporter: r.exporter as SpanExporter }, platform);
  try {
    t.tracerProvider.getTracer("t").startSpan("s").end();
    await r.exported(1);
    await turn();
    assert.deepEqual(droppedOnConsole(platform), [["traces", "CollectorError"]]);
  } finally {
    await t.shutdown();
  }
});

test("with the console sink off, the dropped event is written to the diagnostic stream, without the error's text", async () => {
  const r = refusing();
  const platform = testPlatform(FAST);
  const t = await createTelemetryWith(
    { ...OPTIONS, console: false, spanExporter: r.exporter as SpanExporter },
    platform,
  );
  try {
    t.tracerProvider.getTracer("t").startSpan("s").end();
    await r.exported(1);
    await turn();
    assert.deepEqual(platform.lines, []);
    const [line, ...rest] = droppedOnDiagnostics(platform);
    assert.equal(rest.length, 0);
    assert.match(line ?? "", /o11y\.signal=traces/);
    assert.match(line ?? "", /error\.type=CollectorError/);
    assert.doesNotMatch(line ?? "", /secret-host/);
  } finally {
    await t.shutdown();
  }
});

test("a flush after a background failure neither reports it again nor says it was dropped twice", async () => {
  const r = refusing();
  const platform = testPlatform(FAST);
  const t = await createTelemetryWith({ ...OPTIONS, spanExporter: r.exporter as SpanExporter }, platform);
  try {
    t.tracerProvider.getTracer("t").startSpan("s").end();
    await r.exported(1);
    await turn();
    assert.deepEqual(await t.forceFlush(), { ok: true, errors: [] });
    assert.deepEqual(droppedOnConsole(platform), [["traces", "CollectorError"]]);
  } finally {
    assert.deepEqual(await t.shutdown(), { ok: true, errors: [] });
    assert.equal(droppedOnConsole(platform).length, 1);
  }
});

test("an export that fails while a flush runs is the flush's to report, not a background drop", async () => {
  const r = refusing();
  const platform = testPlatform({});
  const t: Telemetry = await createTelemetryWith(
    { ...OPTIONS, spanExporter: r.exporter as SpanExporter },
    platform,
  );
  try {
    t.tracerProvider.getTracer("t").startSpan("s").end();
    const report = await t.forceFlush();
    assert.deepEqual(
      report.errors.map((e) => e.signal),
      ["traces"],
    );
    assert.deepEqual(droppedOnConsole(platform), []);
  } finally {
    await t.shutdown();
  }
});
