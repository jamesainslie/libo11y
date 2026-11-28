import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeExtension } from "../../../webext/src/test-support/fake-chrome.ts";
import type { SessionState } from "../contracts/session.ts";
import { parseSessionState, SESSION_STORAGE_KEY } from "../session/local-store.ts";
import { allowRumSessionInContentScripts, chromeSessionStore } from "./session-store.ts";

const S: SessionState = { id: "s1", startedAt: 1000, lastActivityAt: 2000, sampled: false };

test("save stores a version 1 record in chrome.storage.session and load reads it back", async () => {
  const ext = createFakeExtension();
  const store = chromeSessionStore(ext.context().chrome);
  store.save(S);
  await ext.settle();
  const raw = ext.sessionStored.get(SESSION_STORAGE_KEY) as Record<string, unknown>;
  assert.equal(raw.v, 1);
  assert.equal(raw.id, "s1");
  assert.equal(typeof raw.w, "string", "the record names the store that wrote it");
  assert.deepEqual(await store.load(), S);
  assert.equal(ext.stored.size, 0, "nothing goes to storage.local");
});

test("another context hears a save, the saving store does not", async () => {
  const ext = createFakeExtension();
  const a = chromeSessionStore(ext.context().chrome);
  const b = chromeSessionStore(ext.context().chrome);
  const heardA: unknown[] = [];
  const heardB: unknown[] = [];
  a.onChange((s) => heardA.push(s));
  b.onChange((s) => heardB.push(s));
  a.save({ ...S, retained: "error" });
  await ext.settle();
  assert.deepEqual(heardA, []);
  assert.deepEqual(heardB, [{ ...S, retained: "error" }]);
});

test("save(undefined) removes the record and other contexts hear undefined", async () => {
  const ext = createFakeExtension();
  const a = chromeSessionStore(ext.context().chrome);
  const b = chromeSessionStore(ext.context().chrome);
  const heard: unknown[] = [];
  b.onChange((s) => heard.push(s));
  a.save(S);
  await ext.settle();
  a.save(undefined);
  await ext.settle();
  assert.equal(ext.sessionStored.has(SESSION_STORAGE_KEY), false);
  assert.deepEqual(heard, [S, undefined]);
  assert.equal(await b.load(), undefined);
});

test("changes to other keys and other areas are ignored", async () => {
  const ext = createFakeExtension();
  const ctx = ext.context();
  const store = chromeSessionStore(ctx.chrome);
  const heard: unknown[] = [];
  store.onChange((s) => heard.push(s));
  await ctx.chrome.storage?.local.set({ [SESSION_STORAGE_KEY]: { v: 1, ...S } });
  await ctx.chrome.storage?.session.set({ other: 1 });
  await ctx.chrome.storage?.session.set({ [SESSION_STORAGE_KEY]: { v: 2, id: "x" } });
  await ext.settle();
  assert.deepEqual(heard, []);
});

test("a content script without session access degrades to a store of its own", async () => {
  const ext = createFakeExtension();
  const page = chromeSessionStore(ext.context().chrome);
  const content = chromeSessionStore(ext.context({ tabId: 7 }).chrome);
  page.save(S);
  await ext.settle();
  assert.equal(await content.load(), undefined);
  content.save({ ...S, id: "s2" });
  await ext.settle();
  assert.equal((ext.sessionStored.get(SESSION_STORAGE_KEY) as { id: string }).id, "s1");
});

test("allowRumSessionInContentScripts opens chrome.storage.session to content scripts", async () => {
  const ext = createFakeExtension();
  const page = chromeSessionStore(ext.context().chrome);
  const content = chromeSessionStore(ext.context({ tabId: 7 }).chrome);
  const heard: unknown[] = [];
  content.onChange((s) => heard.push(s));
  await allowRumSessionInContentScripts(ext.context().chrome);
  page.save(S);
  await ext.settle();
  assert.deepEqual(await content.load(), S);
  assert.deepEqual(heard, [S]);
});

test("allowRumSessionInContentScripts resolves where setAccessLevel or the session area is missing", async () => {
  await allowRumSessionInContentScripts({ storage: { session: {} } } as never);
  await allowRumSessionInContentScripts({} as never);
});

test("load never rejects and save never throws when the area fails", async () => {
  const failing = {
    get: () => Promise.reject(new Error("boom")),
    set: () => Promise.reject(new Error("boom")),
    remove: () => Promise.reject(new Error("boom")),
  };
  const store = chromeSessionStore({
    storage: {
      session: failing,
      onChanged: { addListener() {}, removeListener() {} },
    },
  });
  assert.equal(await store.load(), undefined);
  store.save(S);
  store.save(undefined);
  await new Promise((r) => setTimeout(r, 0));
});

test("parseSessionState ignores the writer field", () => {
  assert.deepEqual(parseSessionState({ v: 1, ...S, w: "token" }), S);
});

test("close stops listening", async () => {
  const ext = createFakeExtension();
  const a = chromeSessionStore(ext.context().chrome);
  const b = chromeSessionStore(ext.context().chrome);
  const heard: unknown[] = [];
  b.onChange((s) => heard.push(s));
  b.close();
  a.save(S);
  await ext.settle();
  assert.deepEqual(heard, []);
});
