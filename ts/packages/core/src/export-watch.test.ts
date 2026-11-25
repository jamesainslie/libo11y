import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExportResult } from "@opentelemetry/core";
import { type ExportObservation, ExportWatch, type WatchedExporter } from "./export-watch.ts";

type Callback = (result: ExportResult) => void;

/** An exporter that keeps each export's callback, so a test decides when and how it finishes. */
function manual(): { exporter: WatchedExporter<string>; callbacks: Callback[]; calls: string[] } {
  const callbacks: Callback[] = [];
  const calls: string[] = [];
  return {
    callbacks,
    calls,
    exporter: {
      export: (_items, cb) => {
        calls.push("export");
        callbacks.push(cb);
      },
      forceFlush: async () => {
        calls.push("forceFlush");
      },
      shutdown: async () => {
        calls.push("shutdown");
      },
    },
  };
}

const OK: ExportResult = { code: 0 };

/** The message of the failure an observation saw, or undefined when it saw none. */
function seenMessage(seen: ExportObservation): string | undefined {
  const failure = seen.failure();
  return failure === undefined ? undefined : (failure.error as Error).message;
}
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("an observation sees the first export that failed while it was open, and nothing before or after", () => {
  const watch = new ExportWatch(1000);
  const { exporter, callbacks } = manual();
  const watched = watch.watch(exporter);
  const results: ExportResult[] = [];

  watched.export("before", (r) => results.push(r));
  callbacks[0]?.({ code: 1, error: new Error("earlier") });

  const seen = watch.observe();
  assert.equal(seen.failure(), undefined, "a failure before the observation is not its business");
  watched.export("a", (r) => results.push(r));
  watched.export("b", (r) => results.push(r));
  watched.export("c", (r) => results.push(r));
  callbacks[1]?.(OK);
  callbacks[2]?.({ code: 1, error: new Error("first") });
  callbacks[3]?.({ code: 1, error: new Error("second") });
  assert.equal(seenMessage(seen), "first");
  seen.end();

  const later = watch.observe();
  watched.export("d", (r) => results.push(r));
  callbacks[4]?.({ code: 1 });
  assert.equal(seenMessage(later), "the export failed");
  assert.equal(seenMessage(seen), "first", "an ended observation stops collecting");
  assert.deepEqual(
    results.map((r) => r.code),
    [1, 0, 1, 1, 1],
    "the processor still gets every result",
  );
});

test("two observations that overlap each see the failure", () => {
  const watch = new ExportWatch(1000);
  const { exporter, callbacks } = manual();
  const watched = watch.watch(exporter);
  const flush = watch.observe();
  const shutdown = watch.observe();
  watched.export("a", () => {});
  callbacks[0]?.({ code: 1, error: new Error("lost") });
  assert.equal(seenMessage(flush), "lost");
  assert.equal(seenMessage(shutdown), "lost");
});

test("an export that throws is a failed export, and its result reaches the processor once", () => {
  const watch = new ExportWatch(1000);
  const results: ExportResult[] = [];
  const watched = watch.watch<string>({
    export: () => {
      throw new Error("serializer broke");
    },
    shutdown: async () => {},
  });
  const seen = watch.observe();
  assert.doesNotThrow(() => watched.export("a", (r) => results.push(r)));
  assert.equal(results.length, 1);
  assert.equal(results[0]?.code, 1);
  assert.equal(seenMessage(seen), "serializer broke");
});

test("a result reported twice counts once", () => {
  const watch = new ExportWatch(1000);
  const { exporter, callbacks } = manual();
  const results: ExportResult[] = [];
  watch.watch(exporter).export("a", (r) => results.push(r));
  callbacks[0]?.(OK);
  callbacks[0]?.({ code: 1, error: new Error("late") });
  assert.deepEqual(results, [OK]);
});

test("an export that never reports is failed at the export timeout, so nothing waits on it for ever", async () => {
  const watch = new ExportWatch(40);
  const { exporter } = manual();
  const results: ExportResult[] = [];
  const seen = watch.observe();
  // The clock is read before the export arms its timer, so the timer cannot fire ahead of it.
  const started = performance.now();
  watch.watch(exporter).export("stuck", (r) => results.push(r));
  assert.equal(results.length, 0, "the export is not failed before its timeout");
  await watch.inFlight();
  const elapsed = performance.now() - started;
  // A timer may fire a millisecond early by this clock, never 10 ms early.
  assert.ok(elapsed >= 30, `the export was failed after ${elapsed.toFixed(0)} ms of a 40 ms timeout`);
  assert.equal(results[0]?.error?.message, "the export timed out");
  assert.equal(seenMessage(seen), "the export timed out");
  await watch.idle();
});

test("idle resolves with nothing in flight, and otherwise when the last export has reported", async () => {
  const watch = new ExportWatch(60_000);
  const { exporter, callbacks } = manual();
  const watched = watch.watch(exporter);
  await watch.idle();
  watched.export("a", () => {});
  watched.export("b", () => {});
  let done = false;
  const idle = watch.idle().then(() => {
    done = true;
  });
  callbacks[0]?.(OK);
  await tick(20);
  assert.equal(done, false, "one export is still in flight");
  callbacks[1]?.(OK);
  await idle;
});

test("idle sees through the gap a processor leaves between two batches", async () => {
  const watch = new ExportWatch(60_000);
  const { exporter, callbacks } = manual();
  const watched = watch.watch(exporter);
  // The processor sends its second batch some microtasks after the first one's result, as
  // upstream's log processor does. However long that chain is, it runs before the next turn.
  watched.export("first", () => {
    let chain = Promise.resolve();
    for (let i = 0; i < 50; i++) chain = chain.then(() => {});
    void chain.then(() => watched.export("second", () => {}));
  });
  let done = false;
  const idle = watch.idle().then(() => {
    done = true;
  });
  callbacks[0]?.(OK);
  await tick(20);
  assert.equal(callbacks.length, 2, "the second batch has started");
  assert.equal(done, false, "idle did not resolve in the gap between the batches");
  callbacks[1]?.(OK);
  await idle;
});

test("inFlight waits for the exports in flight when it is called, and for none that start later", async () => {
  const watch = new ExportWatch(60_000);
  const { exporter, callbacks } = manual();
  const watched = watch.watch(exporter);
  await watch.inFlight();
  watched.export("a", () => {});
  watched.export("b", () => {});
  let done = false;
  const snapshot = watch.inFlight().then(() => {
    done = true;
  });
  watched.export("later", () => {});
  callbacks[0]?.(OK);
  await tick(20);
  assert.equal(done, false, "b was in flight at the call and has not reported");
  callbacks[1]?.(OK);
  await snapshot;
  assert.equal(callbacks.length, 3, "the later export is still out, and was not waited for");
  watch.close();
});

test("shutdown waits for the exports in flight, then stops the exporter once", async () => {
  const watch = new ExportWatch(1000);
  const { exporter, callbacks, calls } = manual();
  const watched = watch.watch(exporter);
  watched.export("a", () => {});
  const stopped = watched.shutdown();
  await tick();
  assert.deepEqual(calls, ["export"], "the exporter is not stopped under an export");
  callbacks[0]?.(OK);
  await stopped;
  await watched.shutdown();
  watch.close();
  await tick();
  assert.deepEqual(calls, ["export", "shutdown"]);
});

test("close fails what is in flight, stops an exporter nobody stopped, and refuses what comes later", async () => {
  const watch = new ExportWatch(60_000);
  const { exporter, callbacks, calls } = manual();
  const watched = watch.watch(exporter);
  const results: ExportResult[] = [];
  watched.export("stuck", (r) => results.push(r));
  const waiting = watched.shutdown();
  watch.close();
  watch.close();
  await waiting;
  await tick();
  assert.equal(results[0]?.error?.message, "the export was abandoned at shutdown");
  assert.deepEqual(calls, ["export", "shutdown"]);

  callbacks[0]?.(OK);
  assert.equal(results.length, 1, "a result that arrives after close changes nothing");
  watched.export("late", (r) => results.push(r));
  assert.equal(results[1]?.error?.message, "the exporter is stopped");
  await watched.forceFlush();
  assert.deepEqual(calls, ["export", "shutdown"], "a closed watch asks nothing more of the exporter");
});

test("close survives an exporter whose shutdown rejects and a processor whose callback throws", async () => {
  const watch = new ExportWatch(60_000);
  const watched = watch.watch<string>({
    export: () => {},
    shutdown: () => Promise.reject(new Error("exporter broke")),
  });
  watched.export("stuck", () => {
    throw new Error("processor broke");
  });
  assert.doesNotThrow(() => watch.close());
  await tick();
});
