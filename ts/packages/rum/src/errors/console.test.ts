import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { watchConsoleErrors } from "./console.ts";
import { createErrorRecorder } from "./recorder.ts";

test("console.error is recorded as console, the original still runs, and stop restores it", () => {
  const rt = fakeRuntime();
  const env = rt.fakeEnv();
  const calls: unknown[][] = [];
  const original = (...a: unknown[]): void => void calls.push(a);
  const con = { error: original };
  const stop = watchConsoleErrors(rt, createErrorRecorder(rt), con, env.setTimeout);
  assert.notEqual(con.error, original);
  con.error("bad", 2);
  con.error("failed:", new TypeError("nope"));
  env.advance(0);
  stop();
  assert.equal(con.error, original);
  assert.deepEqual(calls, [
    ["bad", 2],
    ["failed:", new TypeError("nope")],
  ]);
  assert.deepEqual(rt.counts, ["errors.console", "errors.console"]);
  assert.equal(rt.events[0]?.attrs["exception.type"], "ConsoleError");
  assert.equal(rt.events[1]?.attrs["exception.type"], "TypeError");
  assert.equal(rt.events[1]?.attrs["exception.message"], "failed: nope");
});

test("a logged error something else records in the same task is not recorded again", () => {
  const rt = fakeRuntime();
  const env = rt.fakeEnv();
  const con = { error: (..._a: unknown[]) => {} };
  const rec = createErrorRecorder(rt);
  const stop = watchConsoleErrors(rt, rec, con, env.setTimeout);
  const err = new Error("render failed");
  con.error(err);
  rec.record("boundary", err);
  env.advance(0);
  stop();
  assert.deepEqual(rt.counts, ["errors.boundary"]);
});

test("a console error pending when the recorder stops is dropped", () => {
  const rt = fakeRuntime();
  const env = rt.fakeEnv();
  const con = { error: (..._a: unknown[]) => {} };
  const rec = createErrorRecorder(rt);
  const stop = watchConsoleErrors(rt, rec, con, env.setTimeout);
  con.error(new Error("late"));
  rec.stop();
  stop();
  env.advance(0);
  assert.deepEqual(rt.counts, []);
});
