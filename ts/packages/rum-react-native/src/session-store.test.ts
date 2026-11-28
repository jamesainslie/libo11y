import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_STORAGE_KEY } from "@libo11y/rum/core";
import { fakeStorage } from "../../react-native/src/test-support/fake-storage.ts";
import { storageSessionStore } from "./session-store.ts";

const state = {
  id: "s-1",
  startedAt: 1,
  lastActivityAt: 2,
  sampled: true,
  retained: "head_sampled" as const,
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("save then load round-trips through storage, as the web's versioned record", async () => {
  const storage = fakeStorage();
  storageSessionStore(storage).save(state);
  await tick();
  assert.deepEqual(JSON.parse(storage.map.get(SESSION_STORAGE_KEY) ?? ""), { v: 1, ...state });
  assert.deepEqual(await storageSessionStore(storage).load(), state);
});

test("save(undefined) removes it; a broken record or a failing storage loads undefined", async () => {
  const storage = fakeStorage();
  const s = storageSessionStore(storage);
  s.save(state);
  s.save(undefined);
  await tick();
  assert.equal(await s.load(), undefined);
  assert.equal(storage.map.has(SESSION_STORAGE_KEY), false);
  storage.map.set(SESSION_STORAGE_KEY, "{not json");
  assert.equal(await s.load(), undefined);
  storage.map.set(SESSION_STORAGE_KEY, JSON.stringify({ v: 2, ...state }));
  assert.equal(await s.load(), undefined);
  storage.fail("getItem");
  assert.equal(await s.load(), undefined);
});

test("writes reach storage in call order, and a load waits for them", async () => {
  const storage = fakeStorage();
  const s = storageSessionStore(storage);
  const release = storage.hold();
  s.save(state);
  s.save(undefined);
  s.save({ ...state, id: "s-2" });
  const loaded = s.load();
  release();
  assert.equal((await loaded)?.id, "s-2");
  assert.equal(storage.writes(), 3);
});

test("save never throws, and a failed write does not stop later ones", async () => {
  const storage = fakeStorage();
  const s = storageSessionStore(storage);
  storage.fail("setItem");
  assert.doesNotThrow(() => s.save(state));
  await tick();
  storage.heal();
  s.save({ ...state, id: "s-3" });
  assert.equal((await s.load())?.id, "s-3");
});

test("no other context changes the session, so onChange never fires", () => {
  const s = storageSessionStore(fakeStorage());
  const off = s.onChange(() => assert.fail("onChange fired"));
  s.save(state);
  off();
  s.close();
});
