import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecorderLoader, type RecordFn } from "./recorder.ts";

const fakeRecord = (() => () => {}) as unknown as RecordFn;

test("the loader imports rrweb once, then hands out the recorder without waiting", async () => {
  let imports = 0;
  const load = createRecorderLoader(async () => {
    imports++;
    return { record: fakeRecord };
  });
  const first = load();
  assert.ok(first instanceof Promise, "the first load waits for the import");
  const second = load();
  assert.equal(second, first, "a load while importing shares the import");
  const start = await first;
  assert.equal(typeof start, "function");
  assert.equal(load(), start, "once loaded, the recorder is handed out synchronously");
  assert.equal(imports, 1);
});

test("a failed import is never retried", async () => {
  let imports = 0;
  const load = createRecorderLoader(async () => {
    imports++;
    throw new Error("chunk failed");
  });
  await assert.rejects(Promise.resolve(load()), /chunk failed/);
  await assert.rejects(Promise.resolve(load()), /chunk failed/);
  assert.equal(imports, 1);
});

test("an import that throws synchronously is a failed load, not an exception", async () => {
  const load = createRecorderLoader(() => {
    throw new Error("no dynamic import");
  });
  await assert.rejects(Promise.resolve(load()), /no dynamic import/);
});
