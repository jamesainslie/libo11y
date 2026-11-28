import assert from "node:assert/strict";
import { test } from "node:test";
import { longAnimationFramesWith } from "./loaf.ts";
import { fakeRuntime } from "./test-support/fake-runtime.ts";

type Observe = Parameters<typeof longAnimationFramesWith>[0];

function source(): { observe: Observe; emit(n: number): void; buffered: boolean[]; active: number } {
  const listeners = new Set<(n: number) => void>();
  const s = {
    buffered: [] as boolean[],
    active: 0,
    observe: ((cb, buffered) => {
      s.buffered.push(buffered);
      listeners.add(cb);
      s.active++;
      return () => {
        listeners.delete(cb);
        s.active--;
      };
    }) as Observe,
    emit(n: number) {
      for (const l of [...listeners]) l(n);
    },
  };
  return s;
}

test("long animation frames count into the current view's summary", () => {
  const rt = fakeRuntime();
  const s = source();
  const stop = longAnimationFramesWith(s.observe).start(rt);
  s.emit(2);
  s.emit(1);
  stop();
  assert.deepEqual(rt.counts, ["long_animation_frames", "long_animation_frames"]);
  assert.deepEqual(rt.countValues, [2, 1]);
  assert.equal(s.active, 0, "stop disconnects");
});

test("the first start takes buffered frames, a restart only new ones", () => {
  const rt = fakeRuntime();
  const s = source();
  const c = longAnimationFramesWith(s.observe);
  c.start(rt)();
  c.start(rt);
  assert.deepEqual(s.buffered, [true, false]);
});

test("no frames are counted while consent is not granted, and an empty batch counts nothing", () => {
  const rt = fakeRuntime();
  const s = source();
  longAnimationFramesWith(s.observe).start(rt);
  s.emit(0);
  rt.gate.open = false;
  s.emit(3);
  assert.deepEqual(rt.counts, []);
});
