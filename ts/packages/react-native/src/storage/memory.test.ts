import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStorage } from "./memory.ts";

test("setItem, getItem, removeItem and getAllKeys round trip", async () => {
  const s = memoryStorage();
  assert.equal(await s.getItem("missing"), null);
  await s.setItem("a", "1");
  await s.setItem("b", "2");
  await s.setItem("a", "3");
  assert.equal(await s.getItem("a"), "3");
  assert.deepEqual([...(await s.getAllKeys())].sort(), ["a", "b"]);
  await s.removeItem("a");
  await s.removeItem("never there");
  assert.equal(await s.getItem("a"), null);
  assert.deepEqual(await s.getAllKeys(), ["b"]);
});

test("each memoryStorage is its own", async () => {
  const a = memoryStorage();
  const b = memoryStorage();
  await a.setItem("k", "v");
  assert.equal(await b.getItem("k"), null);
});
