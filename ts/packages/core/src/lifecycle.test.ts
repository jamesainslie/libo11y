/**
 * What forceFlush and shutdown wait for, with exporters whose every result the test decides. There
 * are no sleeps to get an order: a test waits for an export to start, then finishes it by hand.
 *
 * Second review. C1: a flush waited for the whole watch to go idle, so an export a later caller
 * started kept an earlier flush waiting. C2: shutdown stopped the exporter as soon as one span
 * batch failed, which abandoned its sibling batches still in flight. W5: a flush opened a signal's
 * observation only at its turn, and missed a failure that landed before it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { ExportResult } from "@opentelemetry/core";
import { BatchLogRecordProcessor, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import type { SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace";
import { exemplarMetricExporter } from "./exemplars.ts";
import type { TelemetryOptions } from "./options.ts";
import { createTelemetryWith, type SignalReport, type Telemetry } from "./telemetry.ts";
import { createTestPlatform } from "./testing.ts";

const OPTIONS: TelemetryOptions = {
  serviceName: "svc",
  serviceVersion: "1.2.3",
  environment: "test",
  console: false,
};

const NOT_FOUND: ExportResult = { code: 1, error: new Error("Not Found") };

/** One export a manual exporter is holding. */
interface Held {
  /** The span names or log bodies in the batch. */
  readonly items: readonly string[];
  /** Reports the result. Default: success. */
  finish(result?: ExportResult): void;
}

/** An exporter that holds every export until the test finishes it, and records what happened. */
function manual(): {
  exporter: SpanExporter & LogRecordExporter;
  held: Held[];
  events: string[];
  /** Resolves once count exports have started. */
  started(count: number): Promise<void>;
  /** The held export of the batch that carries item. */
  batch(item: string): Held;
} {
  const held: Held[] = [];
  const events: string[] = [];
  let waiting: (() => void)[] = [];
  const exporter = {
    export: (
      batch: readonly { name?: string; body?: unknown }[],
      cb: (result: ExportResult) => void,
    ): void => {
      const items = batch.map((i) => String(i.name ?? i.body));
      events.push(`export ${items.join("+")}`);
      held.push({
        items,
        finish: (result = { code: 0 }) => {
          events.push(`${result.code === 0 ? "ok" : "failed"} ${items.join("+")}`);
          cb(result);
        },
      });
      const wake = waiting;
      waiting = [];
      for (const w of wake) w();
    },
    forceFlush: async (): Promise<void> => {},
    shutdown: async (): Promise<void> => {
      events.push("exporter stopped");
    },
  };
  return {
    exporter: exporter as SpanExporter & LogRecordExporter,
    held,
    events,
    started: (count) =>
      exportsStarted(
        () => held.length,
        count,
        (wake) => waiting.push(wake),
        events,
      ),
    batch: (item) => {
      const found = held.find((h) => h.items.includes(item));
      assert.ok(found !== undefined, `no export carries ${item}: ${events.join(", ")}`);
      return found;
    },
  };
}

/**
 * Resolves once count exports have started. An export that never starts fails the test here, with
 * what did happen, where waiting for it would hang the file.
 */
async function exportsStarted(
  have: () => number,
  count: number,
  wait: (wake: () => void) => void,
  events: readonly string[] = [],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`export ${count} never started; saw: ${events.join(", ").slice(0, 300)}`)),
      2000,
    );
  });
  try {
    while (have() < count) await Promise.race([new Promise<void>((resolve) => wait(resolve)), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function telemetryWith(
  options: TelemetryOptions,
  env: Record<string, string> = {},
): Promise<Telemetry> {
  const platform = createTestPlatform({
    contextManager: () => new AsyncLocalStorageContextManager(),
    env: () => env,
  });
  return createTelemetryWith({ ...OPTIONS, ...options }, platform);
}

function span(t: Telemetry, name: string): void {
  t.tracerProvider.getTracer("t").startSpan(name).end();
}

/** Whether p has settled once the event loop has turned for ms. A promise that waits stays pending however long. */
async function settledWithin(p: Promise<unknown>, ms = 25): Promise<boolean> {
  let settled = false;
  void p.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return settled;
}

function failures(report: SignalReport): [string, string][] {
  return report.errors.map((e) => [e.signal, (e.error as Error).message]);
}

test("C1: a flush waits for the exports in flight when it began, not for one a later flush started", async () => {
  const spans = manual();
  const t = await telemetryWith({ spanExporter: spans.exporter });
  try {
    span(t, "a");
    // A short deadline keeps a failure of this test quick: the flush must not need it.
    const first = t.forceFlush({ timeoutMillis: 500 });
    await spans.started(1);
    span(t, "b");
    const second = t.forceFlush({ timeoutMillis: 5000 });
    await spans.started(2);

    spans.batch("a").finish();
    assert.deepEqual(await first, { ok: true, errors: [] }, "the first flush is done when its own export is");
    assert.equal(await settledWithin(second), false, "the second still waits for its own");
    spans.batch("b").finish();
    assert.deepEqual(await second, { ok: true, errors: [] });
  } finally {
    for (const h of spans.held) h.finish();
    await t.shutdown();
  }
});

test("C1: a flush waits for an export the batch timer had already started, and reports it when it fails", async () => {
  const spans = manual();
  const t = await telemetryWith({ spanExporter: spans.exporter }, { OTEL_BSP_SCHEDULE_DELAY: "1" });
  try {
    span(t, "a");
    await spans.started(1);
    // Nothing is left in the queue: the flush has only the export in flight to wait for.
    const flush = t.forceFlush({ timeoutMillis: 5000 });
    assert.equal(await settledWithin(flush), false, "the flush waits for the export in flight");
    spans.batch("a").finish(NOT_FOUND);
    assert.deepEqual(failures(await flush), [["traces", "o11y: flush traces: Not Found"]]);
  } finally {
    for (const h of spans.held) h.finish();
    await t.shutdown();
  }
});

test("W5: a flush reports an export that fails before its signal's turn comes", async () => {
  const spans = manual();
  const logs = manual();
  const t = await telemetryWith(
    { spanExporter: spans.exporter, logExporter: logs.exporter },
    { OTEL_BSP_SCHEDULE_DELAY: "1" },
  );
  try {
    span(t, "a");
    await spans.started(1);
    t.logger.info("l");
    const flush = t.forceFlush({ timeoutMillis: 5000 });
    // Logs flush first. While their export is out, the span export already in flight fails.
    await logs.started(1);
    spans.batch("a").finish(NOT_FOUND);
    logs.batch("l").finish();
    assert.deepEqual(failures(await flush), [["traces", "o11y: flush traces: Not Found"]]);
  } finally {
    for (const h of [...spans.held, ...logs.held]) h.finish();
    await t.shutdown();
  }
});

test("C2: when one span batch fails, shutdown waits for its sibling batches before it stops the exporter", async () => {
  const spans = manual();
  // A batch of one span: the first span is exported at once, the other two wait in the queue.
  const t = await telemetryWith({ spanExporter: spans.exporter }, { OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "1" });
  span(t, "a");
  span(t, "b");
  span(t, "c");
  await spans.started(1);
  const shutdown = t.shutdown({ timeoutMillis: 5000 });
  await spans.started(3);

  // The provider rejects as soon as one batch fails. The other two are still on their way.
  spans.batch("b").finish(NOT_FOUND);
  assert.equal(await settledWithin(shutdown), false, "shutdown waits for the batches still in flight");
  assert.ok(!spans.events.includes("exporter stopped"), spans.events.join(", "));

  spans.batch("a").finish();
  spans.batch("c").finish();
  assert.deepEqual(failures(await shutdown), [["traces", "o11y: shutdown traces: Not Found"]]);
  assert.deepEqual(spans.events.slice(-3), ["ok a", "ok c", "exporter stopped"]);
});

test("C2: a sibling batch that never answers is abandoned when the deadline passes, not before and not later", async () => {
  const spans = manual();
  // The export timeout is a minute, so only the shutdown deadline can end the wait in time.
  const t = await telemetryWith(
    { spanExporter: spans.exporter },
    { OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "1", OTEL_BSP_EXPORT_TIMEOUT: "60000" },
  );
  span(t, "a");
  span(t, "b");
  await spans.started(1);
  const started = performance.now();
  const shutdown = t.shutdown({ timeoutMillis: 150 });
  await spans.started(2);
  spans.batch("b").finish(NOT_FOUND);
  const late = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), 20_000).unref());
  const report = await Promise.race([shutdown, late]);
  assert.notEqual(report, "late", "shutdown is bounded by its deadline, not by the export timeout");
  if (report === "late") return;
  assert.ok(performance.now() - started >= 140, "shutdown used its deadline for the batch in flight");
  assert.deepEqual(failures(report), [["traces", "o11y: shutdown traces: Not Found"]]);
  assert.equal(spans.events.at(-1), "exporter stopped");
});

test("C2: an injected span processor that fails its shutdown at once does not cost the exporter its last batch", async () => {
  const spans = manual();
  const broken: SpanProcessor = {
    onStart: () => {},
    onEnd: () => {},
    forceFlush: async () => {},
    shutdown: () => Promise.reject(new Error("processor broke")),
  };
  const t = await telemetryWith({ spanExporter: spans.exporter, spanProcessor: broken });
  span(t, "a");
  const shutdown = t.shutdown({ timeoutMillis: 5000 });
  await spans.started(1);
  assert.equal(await settledWithin(shutdown), false, "shutdown waits for the batch in flight");
  spans.batch("a").finish();
  const report = await shutdown;
  assert.equal(report.errors.length, 1);
  assert.match(failures(report)[0]?.[1] ?? "", /processor broke/);
  assert.deepEqual(spans.events, ["export a", "ok a", "exporter stopped"]);
});

test("a clean shutdown waits for an export the batch timer had started, then stops the exporter", async () => {
  const spans = manual();
  const t = await telemetryWith({ spanExporter: spans.exporter }, { OTEL_BSP_SCHEDULE_DELAY: "1" });
  span(t, "a");
  await spans.started(1);
  // Nothing is left to flush: upstream's processor would stop the exporter under this export.
  const shutdown = t.shutdown({ timeoutMillis: 5000 });
  assert.equal(await settledWithin(shutdown), false, "shutdown waits for the export in flight");
  assert.deepEqual(spans.events, ["export a"]);
  spans.batch("a").finish();
  assert.deepEqual(await shutdown, { ok: true, errors: [] });
  assert.deepEqual(spans.events, ["export a", "ok a", "exporter stopped"]);
});

// Fourth review: an overlapping forceFlush resolved ok with its caller's own log record unsent.
// Upstream's log processor returns at once from a flush that overlaps another, and it starts its
// later batches one by one, after the snapshot a flush takes of the exports in flight. A serverless
// handler freezes right after forceFlush resolves, so "ok" has to mean the record has left.

/** A logs-only telemetry whose batch timer never fires during a test. */
function logsOnly(logs: ReturnType<typeof manual>, options: TelemetryOptions = {}): Promise<Telemetry> {
  return telemetryWith({ logExporter: logs.exporter, ...options }, { OTEL_BLRP_SCHEDULE_DELAY: "600000" });
}

test("an overlapping flush resolves only when its caller's record has left: a record in a later batch of the running flush", async () => {
  const logs = manual();
  const t = await logsOnly(logs);
  try {
    // The reviewer's scenario: B's record is buffered when A's flush begins, in its third batch of 512.
    for (let i = 0; i < 1100; i++) t.logger.info(i === 1099 ? "B" : "r");
    const a = t.forceFlush({ timeoutMillis: 5000 });
    await logs.started(1);
    const b = t.forceFlush({ timeoutMillis: 5000 });

    logs.held[0]?.finish();
    await logs.started(2);
    assert.equal(await settledWithin(b), false, "B's record is in the third batch, which has not started");
    logs.held[1]?.finish();
    await logs.started(3);
    assert.ok(logs.held[2]?.items.includes("B"), "the third batch carries B's record");
    assert.equal(await settledWithin(b), false, "B's record is in flight, not delivered");
    logs.held[2]?.finish();
    assert.deepEqual(await a, { ok: true, errors: [] });
    assert.deepEqual(await b, { ok: true, errors: [] });
    assert.equal(logs.held.length, 3, "the follow-up flush found nothing left to send");
  } finally {
    for (const h of logs.held) h.finish();
    await t.shutdown();
  }
});

test("an overlapping flush resolves only when its caller's record has left: a record emitted while the other flush runs", async () => {
  const logs = manual();
  const t = await logsOnly(logs);
  try {
    t.logger.info("A");
    const a = t.forceFlush({ timeoutMillis: 5000 });
    await logs.started(1);
    t.logger.info("B");
    const b = t.forceFlush({ timeoutMillis: 5000 });
    assert.equal(await settledWithin(b), false, "B waits: its record is still buffered");
    assert.equal(logs.held.length, 1, "the follow-up does not start beside the running flush");

    logs.batch("A").finish();
    assert.deepEqual(await a, { ok: true, errors: [] }, "A's flush is done when its own export is");
    await logs.started(2);
    assert.deepEqual(logs.held[1]?.items, ["B"], "the follow-up flush sends B's record");
    assert.equal(await settledWithin(b), false, "B's record is in flight, not delivered");
    logs.batch("B").finish();
    assert.deepEqual(await b, { ok: true, errors: [] });
    assert.deepEqual(logs.events, ["export A", "ok A", "export B", "ok B"]);
  } finally {
    for (const h of logs.held) h.finish();
    await t.shutdown();
  }
});

test("flushes that arrive while one runs share one follow-up flush, and a caller never waits for more than two", async () => {
  const logs = manual();
  const t = await logsOnly(logs);
  try {
    t.logger.info("a");
    const first = t.forceFlush({ timeoutMillis: 5000 });
    await logs.started(1);
    // Five callers arrive while the first flush runs. They do not queue five flushes.
    const callers: Promise<SignalReport>[] = [];
    for (const name of ["b1", "b2", "b3", "b4", "b5"]) {
      t.logger.info(name);
      callers.push(t.forceFlush({ timeoutMillis: 5000 }));
    }
    logs.batch("a").finish();
    assert.deepEqual(await first, { ok: true, errors: [] });
    await logs.started(2);
    assert.deepEqual(logs.held[1]?.items, ["b1", "b2", "b3", "b4", "b5"], "one flush for all five");

    // A caller that arrives during the follow-up is served by the flush after it.
    t.logger.info("c");
    const late = t.forceFlush({ timeoutMillis: 5000 });
    assert.equal(await settledWithin(late), false);
    assert.equal(logs.held.length, 2, "its flush waits for the follow-up to end");
    logs.batch("b1").finish();
    for (const caller of callers) assert.deepEqual(await caller, { ok: true, errors: [] });
    await logs.started(3);
    assert.deepEqual(logs.held[2]?.items, ["c"]);
    assert.equal(await settledWithin(late), false, "its own record is in flight");
    logs.batch("c").finish();
    assert.deepEqual(await late, { ok: true, errors: [] });
    assert.equal(logs.held.length, 3, "seven flushes cost three exports");
  } finally {
    for (const h of logs.held) h.finish();
    await t.shutdown();
  }
});

test("a follow-up flush that loses its export tells every caller that shares it, and the next flush works", async () => {
  const logs = manual();
  const t = await logsOnly(logs);
  try {
    t.logger.info("a");
    const first = t.forceFlush({ timeoutMillis: 5000 });
    await logs.started(1);
    t.logger.info("b");
    const second = t.forceFlush({ timeoutMillis: 5000 });
    const third = t.forceFlush({ timeoutMillis: 5000 });
    logs.batch("a").finish();
    assert.deepEqual(await first, { ok: true, errors: [] }, "the first flush did not lose anything");
    await logs.started(2);
    logs.batch("b").finish(NOT_FOUND);
    assert.deepEqual(failures(await second), [["logs", "o11y: flush logs: Not Found"]]);
    assert.deepEqual(failures(await third), [["logs", "o11y: flush logs: Not Found"]]);

    t.logger.info("c");
    const next = t.forceFlush({ timeoutMillis: 5000 });
    await logs.started(3);
    logs.batch("c").finish();
    assert.deepEqual(await next, { ok: true, errors: [] });
  } finally {
    for (const h of logs.held) h.finish();
    await t.shutdown();
  }
});

test("a caller whose deadline passes while it waits for the running flush says so, and the follow-up still runs", async () => {
  const logs = manual();
  const t = await logsOnly(logs);
  try {
    t.logger.info("a");
    const first = t.forceFlush({ timeoutMillis: 5000 });
    await logs.started(1);
    t.logger.info("b");
    const impatient = t.forceFlush({ timeoutMillis: 40 });
    const patient = t.forceFlush({ timeoutMillis: 5000 });
    // Its record has not left, and the report does not say it has. The one deadline covers every
    // signal, so the signals whose turn never came say the same.
    assert.deepEqual(failures(await impatient), [
      ["logs", "o11y: flush logs: deadline exceeded"],
      ["metrics", "o11y: flush metrics: deadline exceeded"],
      ["traces", "o11y: flush traces: deadline exceeded"],
    ]);
    assert.equal(logs.held.length, 1);

    logs.batch("a").finish();
    assert.deepEqual(await first, { ok: true, errors: [] });
    await logs.started(2);
    assert.deepEqual(logs.held[1]?.items, ["b"]);
    logs.batch("b").finish();
    assert.deepEqual(await patient, { ok: true, errors: [] });
  } finally {
    for (const h of logs.held) h.finish();
    await t.shutdown();
  }
});

// A wrapper around a serverless handler flushes the global providers itself. Its flush is held to
// the same rule, and it cannot break the rule for a telemetry.forceFlush that overlaps it.
test("a flush through the logger provider is coalesced with the telemetry's own", async () => {
  const logs = manual();
  const t = await logsOnly(logs);
  const provider = t.loggerProvider as unknown as { forceFlush(): Promise<void> };
  try {
    t.logger.info("a");
    const direct = provider.forceFlush();
    await logs.started(1);
    t.logger.info("b");
    const own = t.forceFlush({ timeoutMillis: 5000 });
    t.logger.info("c");
    const directAgain = provider.forceFlush();
    assert.equal(await settledWithin(own), false);
    assert.equal(await settledWithin(directAgain), false);
    logs.batch("a").finish();
    await direct;
    await logs.started(2);
    assert.deepEqual(logs.held[1]?.items, ["b", "c"]);
    assert.equal(await settledWithin(own), false, "b is in flight");
    assert.equal(await settledWithin(directAgain), false, "c is in flight");
    logs.batch("b").finish();
    assert.deepEqual(await own, { ok: true, errors: [] });
    await directAgain;
  } finally {
    for (const h of logs.held) h.finish();
    await t.shutdown();
  }
});

test("an injected batch log processor is coalesced too", async () => {
  const logs = manual();
  const t = await telemetryWith({
    logProcessor: new BatchLogRecordProcessor({ exporter: logs.exporter, scheduledDelayMillis: 600_000 }),
  });
  try {
    t.logger.info("A");
    const a = t.forceFlush({ timeoutMillis: 5000 });
    await logs.started(1);
    t.logger.info("B");
    const b = t.forceFlush({ timeoutMillis: 5000 });
    assert.equal(await settledWithin(b), false, "B waits: its record is still buffered");
    logs.batch("A").finish();
    assert.deepEqual(await a, { ok: true, errors: [] });
    await logs.started(2);
    assert.equal(await settledWithin(b), false, "B's record is in flight, not delivered");
    logs.batch("B").finish();
    assert.deepEqual(await b, { ok: true, errors: [] });
  } finally {
    for (const h of logs.held) h.finish();
    await t.shutdown();
  }
});

// The same early return costs a shutdown that overlaps a flush: upstream's shutdown flushes
// nothing while a flush runs, then stops the exporter, and what was emitted meanwhile is never sent.
test("a shutdown that overlaps a flush waits for it, sends what was emitted meanwhile, then stops the exporter", async () => {
  const logs = manual();
  const t = await logsOnly(logs);
  t.logger.info("a");
  const flush = t.forceFlush({ timeoutMillis: 5000 });
  await logs.started(1);
  t.logger.info("late");
  const shutdown = t.shutdown({ timeoutMillis: 5000 });
  assert.equal(await settledWithin(shutdown), false);
  assert.deepEqual(logs.events, ["export a"], "the exporter is not stopped under the running flush");

  logs.batch("a").finish();
  assert.deepEqual(await flush, { ok: true, errors: [] });
  await logs.started(2);
  assert.deepEqual(logs.held[1]?.items, ["late"]);
  assert.equal(await settledWithin(shutdown), false, "shutdown waits for its last export");
  logs.batch("late").finish();
  assert.deepEqual(await shutdown, { ok: true, errors: [] });
  assert.deepEqual(logs.events, ["export a", "ok a", "export late", "ok late", "exporter stopped"]);
});

// Traces and metrics do not need the follow-up. Upstream's span processor hands every buffered
// batch to the exporter before its flush returns (the first C1 test above), and upstream's metric
// reader waits for the collection under way and then runs, or joins, one that began later.
test("an overlapping flush of metrics resolves only when its caller's own measurement has left", async () => {
  const held: { value: number; finish(): void }[] = [];
  const waiting: (() => void)[] = [];
  // Once the test has seen what it came for, exports answer at once: shutdown collects once more.
  let released = false;
  const exporter: PushMetricExporter = {
    export: (metrics, cb) => {
      if (released) {
        cb({ code: 0 });
        return;
      }
      const point = metrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === "c")
        ?.dataPoints[0];
      held.push({ value: Number(point?.value), finish: () => cb({ code: 0 }) });
      for (const w of waiting.splice(0)) w();
    },
    forceFlush: async () => {},
    shutdown: async () => {},
    selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
  };
  const started = (count: number): Promise<void> =>
    exportsStarted(
      () => held.length,
      count,
      (wake) => waiting.push(wake),
    );
  const platform = createTestPlatform({
    contextManager: () => new AsyncLocalStorageContextManager(),
    env: () => ({}),
    buildExporters: (req) => ({
      metricReader: new PeriodicExportingMetricReader({
        exporter: exemplarMetricExporter(exporter, req.exemplars),
        exportIntervalMillis: 3_600_000,
      }),
    }),
  });
  const t = await createTelemetryWith({ ...OPTIONS, runtimeMetrics: false }, platform);
  try {
    const counter = t.meterProvider.getMeter("m").createCounter("c");
    counter.add(1);
    const a = t.forceFlush({ timeoutMillis: 5000 });
    await started(1);
    counter.add(1);
    const b = t.forceFlush({ timeoutMillis: 5000 });
    const c = t.forceFlush({ timeoutMillis: 5000 });
    assert.equal(await settledWithin(b), false);
    held[0]?.finish();
    assert.deepEqual(await a, { ok: true, errors: [] });
    await started(2);
    assert.equal(held[1]?.value, 2, "the next collection carries B's measurement");
    assert.equal(await settledWithin(b), false, "B's measurement is in flight, not delivered");
    assert.equal(await settledWithin(c), false);
    held[1]?.finish();
    assert.deepEqual(await b, { ok: true, errors: [] });
    assert.deepEqual(await c, { ok: true, errors: [] });
    assert.equal(held.length, 2, "the two late callers shared one collection");
  } finally {
    released = true;
    for (const h of held) h.finish();
    await t.shutdown();
  }
});
