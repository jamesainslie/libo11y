import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionState } from "../contracts/session.ts";
import { createChannelHub, createFakeStorage } from "../test-support/fake-storage.ts";
import { localStorageSessionStore, parseSessionState, SESSION_STORAGE_KEY } from "./local-store.ts";

const S: SessionState = { id: "s1", startedAt: 1000, lastActivityAt: 2000, sampled: false };

test("save stores JSON and load reads it back", async () => {
  const storage = createFakeStorage();
  const store = localStorageSessionStore({ storage, channel: createChannelHub().channel() });
  store.save(S);
  assert.deepEqual(JSON.parse(storage.items.get(SESSION_STORAGE_KEY) ?? ""), { v: 1, ...S });
  assert.deepEqual(await store.load(), S);
  store.save(undefined);
  assert.equal(storage.items.has(SESSION_STORAGE_KEY), false);
  assert.equal(await store.load(), undefined);
});

test("another tab hears a save through the channel, not its own", async () => {
  const hub = createChannelHub();
  const storage = createFakeStorage();
  const a = localStorageSessionStore({ storage, channel: hub.channel() });
  const b = localStorageSessionStore({ storage, channel: hub.channel() });
  const heardA: unknown[] = [];
  const heardB: unknown[] = [];
  a.onChange((s) => heardA.push(s));
  b.onChange((s) => heardB.push(s));
  a.save({ ...S, retained: "error" });
  assert.deepEqual(heardA, []);
  assert.deepEqual(heardB, [{ ...S, retained: "error" }]);
  a.save(undefined);
  assert.equal(heardB.length, 2);
  assert.equal(heardB.at(-1), undefined);
});

test("a malformed broadcast is ignored", () => {
  const hub = createChannelHub();
  const sender = hub.channel();
  const store = localStorageSessionStore({ storage: createFakeStorage(), channel: hub.channel() });
  const heard: unknown[] = [];
  store.onChange((s) => heard.push(s));
  sender.postMessage({ session: { v: 1, id: 7 } });
  sender.postMessage("noise");
  sender.postMessage(null);
  assert.deepEqual(heard, []);
});

test("parseSessionState refuses malformed records", () => {
  assert.equal(parseSessionState(null), undefined);
  assert.equal(parseSessionState({ v: 1, id: 3 }), undefined);
  assert.equal(parseSessionState({ v: 2, ...S }), undefined);
  assert.equal(parseSessionState({ v: 1, ...S, retained: "bogus" }), undefined);
  assert.deepEqual(parseSessionState({ v: 1, ...S, configVersion: "c1" }), { ...S, configVersion: "c1" });
});

test("a throwing storage degrades to broadcast only", async () => {
  const storage = {
    getItem(): string | null {
      throw new Error("SecurityError");
    },
    setItem(): void {
      throw new Error("QuotaExceededError");
    },
    removeItem(): void {},
  };
  const store = localStorageSessionStore({ storage, channel: createChannelHub().channel() });
  store.save(S);
  assert.equal(await store.load(), undefined);
});

test("nothing is opened before first use", () => {
  const g = globalThis as { BroadcastChannel?: unknown };
  const before = g.BroadcastChannel;
  let opened = 0;
  g.BroadcastChannel = class {
    constructor() {
      opened++;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    postMessage(): void {}
    close(): void {}
  };
  try {
    const store = localStorageSessionStore({ storage: createFakeStorage() });
    assert.equal(opened, 0);
    store.onChange(() => {});
    assert.equal(opened, 1);
    store.close();
  } finally {
    g.BroadcastChannel = before;
  }
});
