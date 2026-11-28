import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { createErrorRecorder } from "./recorder.ts";

test("records through recordError, at the time given", () => {
  const rt = fakeRuntime();
  const rec = createErrorRecorder(rt);
  rec.record("uncaught", new Error("a"), 7);
  assert.deepEqual(rt.counts, ["errors.uncaught"]);
  assert.deepEqual(
    rt.signals.filter((s) => s.type === "error"),
    [{ type: "error", source: "uncaught", at: 7 }],
  );
});

test("an error raised while one is being recorded is not recorded, and recording says so", () => {
  const rt = fakeRuntime();
  const rec = createErrorRecorder(rt);
  const seen: boolean[] = [];
  rt.bus.subscribe((s) => {
    if (s.type !== "error") return;
    seen.push(rec.recording());
    rec.record("console", new Error("inside"));
  });
  rec.record("uncaught", new Error("outside"));
  assert.deepEqual(seen, [true]);
  assert.equal(rec.recording(), false);
  assert.deepEqual(rt.counts, ["errors.uncaught"]);
});

test("nothing is recorded after stop", () => {
  const rt = fakeRuntime();
  const rec = createErrorRecorder(rt);
  rec.stop();
  rec.record("uncaught", new Error("late"));
  assert.deepEqual(rt.counts, []);
});
