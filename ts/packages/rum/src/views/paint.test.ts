import assert from "node:assert/strict";
import { test } from "node:test";
import { afterNextPaint } from "./paint.ts";

test("afterNextPaint waits for a frame and a task when visible", () => {
  const frames: (() => void)[] = [];
  const tasks: (() => void)[] = [];
  let t = 10;
  const got: number[] = [];
  afterNextPaint(
    {
      requestAnimationFrame: (cb) => frames.push(cb),
      setTimeout: (cb) => tasks.push(cb),
      hidden: () => false,
    },
    () => t,
    (at) => got.push(at),
  );
  assert.equal(tasks.length, 0);
  t = 26;
  frames.shift()?.();
  assert.deepEqual(got, []);
  t = 27;
  tasks.shift()?.();
  assert.deepEqual(got, [27]);
});

test("a hidden page skips the frame", () => {
  const tasks: (() => void)[] = [];
  const got: number[] = [];
  afterNextPaint(
    { requestAnimationFrame: () => 0, setTimeout: (cb) => tasks.push(cb), hidden: () => true },
    () => 5,
    (at) => got.push(at),
  );
  tasks.shift()?.();
  assert.deepEqual(got, [5]);
});

test("without requestAnimationFrame only a task is waited for", () => {
  const tasks: (() => void)[] = [];
  const got: number[] = [];
  afterNextPaint(
    { setTimeout: (cb) => tasks.push(cb), hidden: () => false },
    () => 3,
    (at) => got.push(at),
  );
  tasks.shift()?.();
  assert.deepEqual(got, [3]);
});
