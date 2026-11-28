import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_STORAGE_KEY } from "@libo11y/rum/core";
import { fakeStorage } from "../../react-native/src/test-support/fake-storage.ts";
import { preloadedStorage } from "./config-cache.ts";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("reads come from the copy loaded once, and writes go through to storage", async () => {
  const storage = fakeStorage();
  storage.map.set(CONFIG_STORAGE_KEY, '{"etag":"\\"a\\""}');
  const cache = await preloadedStorage(storage, [CONFIG_STORAGE_KEY]);
  assert.equal(storage.reads(CONFIG_STORAGE_KEY), 1);
  assert.equal(cache.getItem(CONFIG_STORAGE_KEY), '{"etag":"\\"a\\""}');
  assert.equal(storage.reads(CONFIG_STORAGE_KEY), 1, "a read never reaches storage");
  cache.setItem(CONFIG_STORAGE_KEY, "{}");
  assert.equal(cache.getItem(CONFIG_STORAGE_KEY), "{}", "a write is read back at once");
  await tick();
  assert.equal(storage.map.get(CONFIG_STORAGE_KEY), "{}");
  cache.removeItem(CONFIG_STORAGE_KEY);
  assert.equal(cache.getItem(CONFIG_STORAGE_KEY), null);
  await tick();
  assert.equal(storage.map.has(CONFIG_STORAGE_KEY), false);
});

test("writes reach storage in call order", async () => {
  const storage = fakeStorage();
  const cache = await preloadedStorage(storage, [CONFIG_STORAGE_KEY]);
  const release = storage.hold();
  cache.setItem(CONFIG_STORAGE_KEY, "1");
  cache.removeItem(CONFIG_STORAGE_KEY);
  cache.setItem(CONFIG_STORAGE_KEY, "2");
  release();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(storage.map.get(CONFIG_STORAGE_KEY), "2");
});

test("an unreadable key starts empty, a failed write keeps the value for this run, and keys outside the list are not served", async () => {
  const storage = fakeStorage();
  storage.fail("getItem");
  const cache = await preloadedStorage(storage, ["a"]);
  assert.equal(cache.getItem("a"), null);
  storage.fail("setItem");
  cache.setItem("a", "x");
  await tick();
  assert.equal(cache.getItem("a"), "x");
  storage.heal();
  cache.setItem("b", "y");
  assert.equal(cache.getItem("b"), null);
  await tick();
  assert.equal(storage.map.has("b"), false);
});
