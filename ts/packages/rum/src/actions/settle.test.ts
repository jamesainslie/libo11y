import assert from "node:assert/strict";
import { test } from "node:test";
import { manualTimers } from "../test-support/manual-timers.ts";
import { createSettleTracker } from "./settle.ts";

function setup(start = 0) {
  const c = manualTimers(start);
  const ends: number[] = [];
  const s = createSettleTracker({
    start,
    idleMillis: 100,
    capMillis: 10_000,
    now: c.now,
    timers: c.timers,
    onSettle: (e) => ends.push(e),
  });
  return { c, ends, s };
}

test("an action with no activity settles at its start after 100 ms", () => {
  const { c, ends } = setup();
  c.advance(99);
  assert.deepEqual(ends, []);
  c.advance(1);
  assert.deepEqual(ends, [0]);
  assert.equal(c.pending(), 0, "no timer is left behind");
});

test("an action ends at its last request end once idle", () => {
  const { c, ends, s } = setup();
  s.requestStarted("r1", 5);
  c.advance(300);
  assert.deepEqual(ends, [], "a pending request holds it open");
  s.requestEnded("r1", 300);
  c.advance(50);
  s.activity(350);
  c.advance(99);
  assert.deepEqual(ends, []);
  c.advance(1);
  assert.deepEqual(ends, [350]);
});

test("an unknown request end is ignored", () => {
  const { c, ends, s } = setup();
  s.requestEnded("other", 50);
  c.advance(100);
  assert.deepEqual(ends, [0]);
});

test("the cap ends a never-idle action at 10 s", () => {
  const { c, ends, s } = setup();
  s.requestStarted("poll", 1);
  c.advance(10_000);
  assert.deepEqual(ends, [10_000]);
});

test("the cap counts from the action's start, not from the tracker's creation", () => {
  const c = manualTimers(40);
  const ends: number[] = [];
  const s = createSettleTracker({
    start: 0,
    idleMillis: 100,
    capMillis: 10_000,
    now: c.now,
    timers: c.timers,
    onSettle: (e) => ends.push(e),
  });
  s.requestStarted("poll", 41);
  c.advance(9960);
  assert.deepEqual(ends, [10_000]);
});

test("end() settles at once at the last activity, and only once", () => {
  const { c, ends, s } = setup();
  s.activity(40);
  c.advance(50);
  s.end();
  s.end();
  c.advance(1000);
  assert.deepEqual(ends, [40]);
});

test("activity after settling is ignored", () => {
  const { c, ends, s } = setup();
  c.advance(100);
  s.activity(150);
  s.requestStarted("r", 150);
  c.advance(1000);
  assert.deepEqual(ends, [0]);
});
