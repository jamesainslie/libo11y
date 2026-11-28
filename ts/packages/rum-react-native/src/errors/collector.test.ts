import assert from "node:assert/strict";
import { test } from "node:test";
import type { Telemetry } from "@libo11y/core";
import { type FakeRuntime, fakeRuntime } from "../../../rum/src/test-support/fake-runtime.ts";
import { fakeRn } from "../test-support/fake-rn.ts";
import { errorsWith } from "./collector.ts";

const sources = (rt: FakeRuntime): unknown[] => rt.events.map((e) => e.attrs["o11y.rum.error.source"]);

/** Replaces the fake telemetry's forceFlush; its report is not read. */
function flushWith(rt: FakeRuntime, forceFlush: () => Promise<void>): void {
  (rt.telemetry as { forceFlush: Telemetry["forceFlush"] }).forceFlush =
    forceFlush as unknown as Telemetry["forceFlush"];
}

const ticks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("the collector is named errors", () => {
  assert.equal(errorsWith(fakeRn().env).name, "errors");
});

test("a non-fatal error is recorded as uncaught and the previous handler runs at once", () => {
  const rn = fakeRn();
  const rt = fakeRuntime();
  const stop = errorsWith(rn.env).start(rt);
  const err = new Error("soft");
  rn.throwGlobal(err, false);
  assert.deepEqual(sources(rt), ["uncaught"]);
  assert.equal(rt.events[0]?.attrs["exception.message"], "soft");
  assert.deepEqual(rt.counts, ["errors.uncaught"]);
  assert.deepEqual(rn.previousCalls(), [[err, false]]);
  stop();
});

test("a fatal error is recorded as uncaught, sends the summaries and flushes, then the previous handler runs", async () => {
  const rn = fakeRn();
  const rt = fakeRuntime();
  const order: string[] = [];
  const flush = rt.summary.flush.bind(rt.summary);
  rt.summary.flush = () => {
    order.push("summaries");
    flush();
  };
  let flushed!: () => void;
  flushWith(rt, () => {
    order.push("flush");
    return new Promise<void>((r) => {
      flushed = r;
    });
  });
  errorsWith(rn.env, { fatalFlushMillis: 2000 }).start(rt);
  const err = new Error("fatal");
  rn.throwGlobal(err, true);
  assert.deepEqual(sources(rt), ["uncaught"]);
  assert.deepEqual(order, ["summaries", "flush"]);
  assert.equal(rn.previousCalls().length, 0, "waits for the flush");
  flushed();
  await ticks();
  assert.deepEqual(rn.previousCalls(), [[err, true]]);
  rn.advance(5000);
  assert.equal(rn.previousCalls().length, 1, "the timer that gave up was cleared");
});

test("a fatal flush that hangs gives up after fatalFlushMillis", async () => {
  const rn = fakeRn();
  const rt = fakeRuntime();
  flushWith(rt, () => new Promise<void>(() => {}));
  errorsWith(rn.env, { fatalFlushMillis: 2000 }).start(rt);
  rn.throwGlobal(new Error("fatal"), true);
  rn.advance(1999);
  assert.equal(rn.previousCalls().length, 0);
  rn.advance(1);
  assert.equal(rn.previousCalls().length, 1);
  await ticks();
  assert.equal(rn.previousCalls().length, 1);
});

test("the fatal flush waits 2 seconds by default", () => {
  const rn = fakeRn();
  const rt = fakeRuntime();
  flushWith(rt, () => new Promise<void>(() => {}));
  errorsWith(rn.env).start(rt);
  rn.throwGlobal(new Error("fatal"), true);
  rn.advance(1999);
  assert.equal(rn.previousCalls().length, 0);
  rn.advance(1);
  assert.equal(rn.previousCalls().length, 1);
});

test("a fatal flush that rejects or throws still hands on to the previous handler", async () => {
  const rn = fakeRn();
  const rt = fakeRuntime();
  flushWith(rt, () => Promise.reject(new Error("export failed")));
  const stop = errorsWith(rn.env).start(rt);
  rn.throwGlobal(new Error("one"), true);
  await ticks();
  assert.equal(rn.previousCalls().length, 1);
  stop();

  const rn2 = fakeRn();
  const rt2 = fakeRuntime();
  flushWith(rt2, () => {
    throw new Error("no telemetry");
  });
  errorsWith(rn2.env).start(rt2);
  rn2.throwGlobal(new Error("two"), true);
  assert.equal(rn2.previousCalls().length, 1);
});

test("an error raised while one is being recorded is handed on without being recorded again", () => {
  const rn = fakeRn();
  const rt = fakeRuntime();
  errorsWith(rn.env).start(rt);
  const inner = new Error("inner");
  rt.bus.subscribe((s) => {
    if (s.type === "error" && rn.previousCalls().length === 0) rn.throwGlobal(inner, false);
  });
  const outer = new Error("outer");
  rn.throwGlobal(outer, false);
  assert.deepEqual(rt.counts, ["errors.uncaught"]);
  assert.deepEqual(
    rn.previousCalls().map(([e]) => e),
    [inner, outer],
  );
});

test("stop restores the previous handler while ours is installed", () => {
  const rn = fakeRn();
  const rt = fakeRuntime();
  const stop = errorsWith(rn.env).start(rt);
  assert.notEqual(rn.env.errorUtils?.getGlobalHandler(), rn.original);
  stop();
  assert.equal(rn.env.errorUtils?.getGlobalHandler(), rn.original);
  rn.throwGlobal(new Error("after"), false);
  assert.deepEqual(rt.counts, []);
});

test("after stop, a handler chained over ours stays, and ours hands on without recording or waiting", () => {
  const rn = fakeRn();
  const rt = fakeRuntime();
  flushWith(rt, () => new Promise<void>(() => {}));
  const stop = errorsWith(rn.env).start(rt);
  const ours = rn.env.errorUtils?.getGlobalHandler();
  const theirs = (e: unknown, f?: boolean): void => ours?.(e, f);
  rn.env.errorUtils?.setGlobalHandler(theirs);
  stop();
  assert.equal(rn.env.errorUtils?.getGlobalHandler(), theirs);
  rn.throwGlobal(new Error("late"), true);
  assert.deepEqual(rt.counts, []);
  assert.equal(rn.previousCalls().length, 1);
});

test("rejections are tracked in release builds by default, recorded as unhandled_rejection", () => {
  const rn = fakeRn({ dev: false });
  const rt = fakeRuntime();
  const stop = errorsWith(rn.env).start(rt);
  assert.equal(rn.tracker()?.allRejections, true);
  rn.reject(new Error("lost"));
  assert.deepEqual(sources(rt), ["unhandled_rejection"]);
  assert.equal(rt.events[0]?.attrs["exception.message"], "lost");
  assert.deepEqual(rn.warnings(), [], "release shows no warning");
  stop();
  rn.reject(new Error("after stop"));
  assert.equal(rt.events.length, 1, "the tracker cannot be removed, so it is muted");
});

test("in development the tracker is left to React Native's LogBox warning by default", () => {
  const rn = fakeRn({ dev: true });
  errorsWith(rn.env).start(fakeRuntime());
  assert.equal(rn.trackerInstalled(), false);
});

test("unhandledRejections always replaces the development warning with one console.warn line", () => {
  const rn = fakeRn({ dev: true });
  const rt = fakeRuntime();
  errorsWith(rn.env, { unhandledRejections: "always" }).start(rt);
  rn.reject("plain string");
  assert.deepEqual(sources(rt), ["unhandled_rejection"]);
  assert.equal(rt.events[0]?.attrs["exception.message"], "plain string");
  assert.equal(rn.warnings().length, 1, "development keeps a visible warning");
  assert.deepEqual(rn.warnings()[0], ["Possible unhandled promise rejection:", "plain string"]);
});

test("unhandledRejections never leaves the tracker alone in release too", () => {
  const rn = fakeRn({ dev: false });
  errorsWith(rn.env, { unhandledRejections: "never" }).start(fakeRuntime());
  assert.equal(rn.trackerInstalled(), false);
});

test("no ErrorUtils and no HermesInternal, as on Expo web: nothing installs and nothing throws", () => {
  const rt = fakeRuntime();
  const { errorUtils: _e, hermes: _h, ...env } = fakeRn().env;
  const stop = errorsWith(env, { unhandledRejections: "always" }).start(rt);
  stop();
  assert.deepEqual(rt.counts, []);
});

test("a failed request is a network error", () => {
  const rt = fakeRuntime();
  const stop = errorsWith(fakeRn().env).start(rt);
  rt.bus.publish({ type: "request-start", spanId: "a", method: "POST", url: "https://api.test/x", at: 1 });
  rt.bus.publish({ type: "request-end", spanId: "a", errorType: "TypeError", at: 2 });
  stop();
  assert.deepEqual(sources(rt), ["network"]);
  assert.equal(rt.events[0]?.attrs["exception.message"], "POST api.test failed");
});

test("console.error is captured only with console on, and stop restores it", () => {
  const off = fakeRn();
  const rtOff = fakeRuntime();
  const before = off.env.console?.error;
  errorsWith(off.env).start(rtOff);
  assert.equal(off.env.console?.error, before);

  const rn = fakeRn();
  const rt = fakeRuntime();
  const original = rn.env.console?.error;
  const stop = errorsWith(rn.env, { console: true }).start(rt);
  rn.env.console?.error("bad", 2);
  rn.env.console?.error(new Error("deferred"));
  rn.advance(0);
  stop();
  assert.equal(rn.env.console?.error, original);
  assert.deepEqual(sources(rt), ["console", "console"]);
  assert.equal(rt.events[0]?.attrs["exception.message"], "bad 2");
  assert.equal(rn.consoleErrors().length, 2, "the original console.error still runs");
});
