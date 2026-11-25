import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChromeLike } from "./chrome.ts";
import { CONSENT_STORAGE_KEY, readStoredConsent, syncConsent } from "./consent-sync.ts";
import { createFakeExtension } from "./test-support/fake-chrome.ts";
import { createFakeConsentController } from "./test-support/fake-consent.ts";

test("the storage key is libo11y.consent", () => {
  assert.equal(CONSENT_STORAGE_KEY, "libo11y.consent");
});

test("readStoredConsent returns each stored state", async () => {
  for (const state of ["pending", "granted", "denied"] as const) {
    const ext = createFakeExtension();
    ext.stored.set(CONSENT_STORAGE_KEY, state);
    assert.equal(await readStoredConsent(ext.context().chrome), state);
  }
});

test("readStoredConsent is undefined when nothing, or something malformed, is stored", async () => {
  const ext = createFakeExtension();
  assert.equal(await readStoredConsent(ext.context().chrome), undefined);
  for (const bad of [42, "yes", "GRANTED", { state: "granted" }, null, true]) {
    ext.stored.set(CONSENT_STORAGE_KEY, bad);
    assert.equal(await readStoredConsent(ext.context().chrome), undefined, JSON.stringify(bad));
  }
});

test("readStoredConsent is undefined without storage or when storage fails", async () => {
  const ext = createFakeExtension();
  ext.stored.set(CONSENT_STORAGE_KEY, "granted");
  assert.equal(await readStoredConsent(ext.context({ withoutStorage: true }).chrome), undefined);
  const broken = ext.context().chrome;
  const failing: ChromeLike = {
    runtime: broken.runtime,
    storage: {
      local: {
        get: () => Promise.reject(new Error("storage is broken")),
        set: () => Promise.reject(new Error("storage is broken")),
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
  assert.equal(await readStoredConsent(failing), undefined);
});

test("every controller change is written", async () => {
  const ext = createFakeExtension();
  const controller = createFakeConsentController("pending");
  syncConsent(controller, ext.context().chrome);
  controller.consent.grant();
  await ext.settle();
  assert.equal(ext.stored.get(CONSENT_STORAGE_KEY), "granted");
  await controller.consent.revoke();
  await ext.settle();
  assert.equal(ext.stored.get(CONSENT_STORAGE_KEY), "denied");
  assert.deepEqual(ext.writes, [{ [CONSENT_STORAGE_KEY]: "granted" }, { [CONSENT_STORAGE_KEY]: "denied" }]);
  // The echo of its own writes changes nothing here.
  assert.deepEqual(controller.calls, { grant: 1, revoke: 1 });
  assert.equal(controller.consent.state(), "denied");
});

test("a grant from another context is applied once and not written back", async () => {
  const ext = createFakeExtension();
  const here = createFakeConsentController("pending");
  syncConsent(here, ext.context({ tabId: 3 }).chrome);
  await ext.context().chrome.storage?.local.set({ [CONSENT_STORAGE_KEY]: "granted" });
  await ext.settle();
  assert.equal(here.consent.state(), "granted");
  assert.deepEqual(here.calls, { grant: 1, revoke: 0 });
  assert.equal(ext.writes.length, 1);
});

test("a revoke from another context is applied, running this context's revoke hooks", async () => {
  const ext = createFakeExtension();
  const here = createFakeConsentController("granted");
  let cleared = 0;
  here.onRevoke(() => {
    cleared++;
  });
  syncConsent(here, ext.context().chrome);
  await ext.context().chrome.storage?.local.set({ [CONSENT_STORAGE_KEY]: "denied" });
  await ext.settle();
  assert.equal(here.consent.state(), "denied");
  assert.equal(cleared, 1);
  assert.equal(ext.writes.length, 1);
});

test("two synced contexts agree, whichever changes", async () => {
  const ext = createFakeExtension();
  const worker = createFakeConsentController("pending");
  const content = createFakeConsentController("pending");
  syncConsent(worker, ext.context().chrome);
  syncConsent(content, ext.context({ tabId: 1 }).chrome);
  content.consent.grant();
  await ext.settle();
  assert.equal(worker.consent.state(), "granted");
  await worker.consent.revoke();
  await ext.settle();
  assert.equal(content.consent.state(), "denied");
  worker.consent.grant();
  await ext.settle();
  assert.equal(content.consent.state(), "granted");
  assert.deepEqual(worker.calls, { grant: 2, revoke: 1 });
  assert.deepEqual(content.calls, { grant: 2, revoke: 1 });
  assert.equal(ext.writes.length, 3);
});

test("quick own changes are not undone by the echo of an earlier write", async () => {
  const ext = createFakeExtension();
  const here = createFakeConsentController("pending");
  syncConsent(here, ext.context().chrome);
  here.consent.grant();
  void here.consent.revoke();
  await ext.settle();
  assert.equal(here.consent.state(), "denied");
  assert.equal(ext.stored.get(CONSENT_STORAGE_KEY), "denied");
  assert.deepEqual(here.calls, { grant: 1, revoke: 1 });
});

test("malformed values, pending, other keys and other areas are ignored", async () => {
  const ext = createFakeExtension();
  const here = createFakeConsentController("granted");
  const chrome = ext.context().chrome;
  syncConsent(here, chrome);
  const other = ext.context().chrome;
  for (const bad of [42, "yes", { state: "denied" }, "pending"]) {
    await other.storage?.local.set({ [CONSENT_STORAGE_KEY]: bad });
  }
  await other.storage?.local.set({ "something.else": "denied" });
  await ext.settle();
  assert.equal(here.consent.state(), "granted");
  assert.deepEqual(here.calls, { grant: 0, revoke: 0 });
});

test("a change in another storage area is ignored", async () => {
  const ext = createFakeExtension();
  const here = createFakeConsentController("granted");
  const listeners: ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[] = [];
  const base = ext.context().chrome;
  // The local area still says granted; only the sync area changed.
  let reads = 0;
  const chrome: ChromeLike = {
    runtime: base.runtime,
    storage: {
      local: {
        get: async () => {
          reads++;
          return { [CONSENT_STORAGE_KEY]: "granted" };
        },
        set: async () => {},
      },
      onChanged: { addListener: (l) => listeners.push(l), removeListener() {} },
    },
  };
  syncConsent(here, chrome);
  await new Promise((r) => setTimeout(r, 10));
  const before = reads;
  for (const l of listeners) l({ [CONSENT_STORAGE_KEY]: { newValue: "denied" } }, "sync");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(reads, before);
  assert.equal(here.consent.state(), "granted");
});

test("stopping ends the sync both ways", async () => {
  const ext = createFakeExtension();
  const here = createFakeConsentController("pending");
  const { stop } = syncConsent(here, ext.context().chrome);
  stop();
  here.consent.grant();
  await ext.context().chrome.storage?.local.set({ [CONSENT_STORAGE_KEY]: "denied" });
  await ext.settle();
  assert.equal(here.consent.state(), "granted");
  assert.equal(ext.writes.length, 1);
});

test("without storage the sync is a no-op", () => {
  const ext = createFakeExtension();
  const here = createFakeConsentController("pending");
  const { stop } = syncConsent(here, ext.context({ withoutStorage: true }).chrome);
  here.consent.grant();
  stop();
  assert.equal(here.consent.state(), "granted");
});

test("a failing write is reported, never thrown", async () => {
  const ext = createFakeExtension();
  const base = ext.context().chrome;
  const chrome: ChromeLike = {
    runtime: base.runtime,
    storage: {
      local: { get: async () => ({}), set: () => Promise.reject(new Error("quota")) },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
  const here = createFakeConsentController("pending");
  syncConsent(here, chrome);
  assert.equal(here.consent.grant(), "granted");
  await new Promise((r) => setTimeout(r, 10));
});

test("refresh applies the stored state before it resolves, without writing it back", async () => {
  const ext = createFakeExtension();
  const here = createFakeConsentController("pending");
  const sync = syncConsent(here, ext.context().chrome);
  await ext.settle();
  // Stored by another context; its onChanged has not arrived here.
  ext.stored.set(CONSENT_STORAGE_KEY, "granted");
  await sync.refresh();
  assert.equal(here.consent.state(), "granted");
  ext.stored.set(CONSENT_STORAGE_KEY, "denied");
  await sync.refresh();
  assert.equal(here.consent.state(), "denied");
  await ext.settle();
  assert.equal(ext.writes.length, 0);
  sync.stop();
  ext.stored.set(CONSENT_STORAGE_KEY, "granted");
  await sync.refresh();
  assert.equal(here.consent.state(), "denied");
});
