import assert from "node:assert/strict";
import { test } from "node:test";
import { manualTimers } from "../../rum/src/test-support/manual-timers.ts";
import type { RrwebEvent } from "./scrub.ts";
import { type ClosedSegment, createSegmenter, type Segmenter } from "./segmenter.ts";

const meta = (t: number): RrwebEvent => ({ type: 4, timestamp: t, data: { href: "/", width: 1, height: 1 } });
const full = (t: number): RrwebEvent => ({ type: 2, timestamp: t, data: { node: { type: 0, id: 1 } } });
const move = (t: number): RrwebEvent => ({ type: 3, timestamp: t, data: { source: 1, positions: [] } });
const mutation = (t: number): RrwebEvent => ({
  type: 3,
  timestamp: t,
  data: { source: 0, texts: [], attributes: [], removes: [], adds: [] },
});

function setup(o: { maxBytes?: number; maxEvents?: number } = {}): {
  seg: Segmenter;
  closed: ClosedSegment[];
  log: string[];
  clock: ReturnType<typeof manualTimers>;
} {
  const clock = manualTimers(1000);
  const closed: ClosedSegment[] = [];
  const log: string[] = [];
  let seg: Segmenter | undefined;
  seg = createSegmenter({
    recording: "rec-0001",
    maxMillis: 30_000,
    maxBytes: o.maxBytes ?? 1_048_576,
    maxEvents: o.maxEvents ?? 10_000,
    maxRequests: 200,
    timers: clock.timers,
    checkout: () => {
      log.push("checkout");
      seg?.push(meta(clock.now()));
      seg?.push(full(clock.now()));
    },
    onClose: (s) => {
      log.push(`close ${s.envelope.events.length}`);
      closed.push(s);
    },
  });
  return { seg, closed, log, clock };
}

test("the first segment opens with the recorder's snapshot and closes on a cut", () => {
  const { seg, closed } = setup();
  seg.push(meta(1000));
  seg.push(full(1001));
  seg.push(move(1005));
  assert.equal(seg.openEvents(), 3);
  seg.cut("hide");
  assert.equal(closed.length, 1);
  const s = closed[0];
  assert.ok(s);
  assert.equal(s.first, true);
  assert.equal(s.envelope.format, 1);
  assert.equal(s.envelope.recording, "rec-0001");
  assert.deepEqual(
    s.envelope.events.map((e) => e.type),
    [4, 2, 3],
  );
  assert.equal(s.envelope.start, 1000);
  assert.equal(s.envelope.end, 1005);
  assert.equal(seg.openEvents(), 0);
});

test("a first segment holding only its snapshot still closes and is passed on", () => {
  const { seg, closed } = setup();
  seg.push(meta(1000));
  seg.push(full(1001));
  seg.cut("stop");
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.first, true);
});

test("the timer closes a segment after maxMillis, and the next event checks out a new one", () => {
  const { seg, closed, log, clock } = setup();
  seg.push(meta(1000));
  seg.push(full(1000));
  seg.push(move(1001));
  clock.advance(30_000);
  assert.deepEqual(log, ["close 3"]);
  // An idle page takes no snapshot of its own.
  clock.advance(60_000);
  assert.deepEqual(log, ["close 3"]);
  seg.push(move(clock.now()));
  assert.deepEqual(log, ["close 3"], "the checkout waits for a timer, outside the recorder's emit");
  clock.advance(0);
  assert.deepEqual(log, ["close 3", "checkout"]);
  seg.cut("hide");
  const second = closed[1];
  assert.ok(second);
  assert.equal(second.first, false);
  assert.deepEqual(
    second.envelope.events.map((e) => e.type),
    [4, 2, 3],
    "the move that asked for the checkout follows the snapshot",
  );
});

test("mutations while a checkout is pending are dropped: the new snapshot holds them", () => {
  const { seg, closed, clock } = setup();
  seg.push(meta(1000));
  seg.push(full(1000));
  seg.push(move(1001));
  seg.cut("hide");
  seg.push(mutation(1002));
  seg.push(move(1003));
  seg.push(mutation(1004));
  clock.advance(0);
  seg.cut("hide");
  assert.deepEqual(
    closed[1]?.envelope.events.map((e) => [e.type, (e.data as { source?: number }).source]),
    [
      [4, undefined],
      [2, undefined],
      [3, 1],
    ],
  );
});

test("the byte cap counts what follows the snapshot, closes the segment, and the next event checks out", () => {
  const big = JSON.stringify(move(0)).length;
  const { seg, closed, log, clock } = setup({ maxBytes: big * 2 });
  seg.push(meta(1000));
  seg.push(full(1000));
  seg.push(move(1001));
  assert.deepEqual(log, []);
  seg.push(move(1002));
  assert.deepEqual(log, ["close 4"]);
  seg.push(move(1003));
  clock.advance(0);
  assert.deepEqual(log, ["close 4", "checkout"]);
  assert.equal(closed.length, 1);
});

test("the event cap closes a segment", () => {
  const { seg, log } = setup({ maxEvents: 4 });
  seg.push(meta(1000));
  seg.push(full(1000));
  seg.push(move(1001));
  seg.push(move(1002));
  assert.deepEqual(log, ["close 4"]);
});

test("a segment after the first holding only its snapshot is not passed on", () => {
  const { seg, closed, clock } = setup();
  seg.push(meta(1000));
  seg.push(full(1000));
  seg.cut("hide");
  seg.push(move(1001));
  seg.cut("hide");
  clock.advance(0);
  seg.cut("hide");
  assert.equal(closed.length, 1, "the move was dropped by the cut before its checkout ran");
  seg.push(meta(1002));
  seg.push(full(1002));
  seg.cut("hide");
  assert.equal(closed.length, 1);
});

test("an unasked snapshot opens a new segment and closes the open one", () => {
  const { seg, closed } = setup();
  seg.push(meta(1000));
  seg.push(full(1000));
  seg.push(move(1001));
  seg.push(meta(1002));
  seg.push(full(1002));
  assert.equal(closed.length, 1);
  assert.equal(seg.openEvents(), 2);
});

test("views: the current view opens each segment, and views while open are added", () => {
  const { seg, closed, clock } = setup();
  seg.view({ id: "v1", name: "/a", at: 999 });
  seg.push(meta(1000));
  seg.push(full(1000));
  seg.view({ id: "v2", name: "/b", at: 1001, trace_id: "a".repeat(32), span_id: "b".repeat(16) });
  seg.push(move(1001));
  seg.cut("hide");
  seg.push(move(1002));
  clock.advance(0);
  seg.cut("hide");
  assert.deepEqual(
    closed.map((s) => s.envelope.views.map((v) => v.id)),
    [["v1", "v2"], ["v2"]],
  );
});

test("requests keep the first maxRequests of a segment", () => {
  const { seg, closed } = setup();
  seg.push(meta(1000));
  seg.push(full(1000));
  for (let i = 0; i < 250; i++) seg.request({ trace_id: "a".repeat(32), span_id: "b".repeat(16), at: i });
  seg.push(move(1001));
  seg.cut("hide");
  assert.equal(closed[0]?.envelope.requests.length, 200);
  assert.equal(closed[0]?.envelope.requests[0]?.at, 0);
});

test("requests and views outside a segment are not kept for the next one, except the current view", () => {
  const { seg, closed, clock } = setup();
  seg.request({ trace_id: "a".repeat(32), span_id: "b".repeat(16), at: 1 });
  seg.push(meta(1000));
  seg.push(full(1000));
  seg.push(move(1001));
  seg.cut("hide");
  clock.advance(0);
  assert.equal(closed[0]?.envelope.requests.length, 0);
});
