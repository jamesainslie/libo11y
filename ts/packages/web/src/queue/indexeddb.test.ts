import assert from "node:assert/strict";
import { test } from "node:test";
import { type DiagLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { forceCloseDatabase, IDBFactory, IDBObjectStore } from "fake-indexeddb";
import type { PersistentQueue, QueueOptions } from "../contracts/queue.ts";
import { brokenFactory, queueConformance, spyFactory } from "../test-support/queue-conformance.ts";
import { openIndexedDbQueue, STORE_NAME } from "./indexeddb.ts";

queueConformance("indexeddb", (opts) => openIndexedDbQueue({ ...opts, indexedDB: new IDBFactory() }));

const T0 = 1_700_000_000_000;

// fake-indexeddb types the argument as the class rather than an instance.
const forceClose = forceCloseDatabase as unknown as (db: IDBDatabase) => void;

async function withDiag(fn: (messages: string[]) => Promise<void>): Promise<void> {
  const messages: string[] = [];
  const push = (msg: string) => {
    messages.push(msg);
  };
  const logger: DiagLogger = { error: push, warn: push, info: () => {}, debug: () => {}, verbose: () => {} };
  diag.setLogger(logger, { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true });
  try {
    await fn(messages);
  } finally {
    diag.disable();
  }
}

function opts(factory: IDBFactory, extra: QueueOptions = {}): QueueOptions {
  return { indexedDB: factory, now: () => T0, ...extra };
}

test("the IndexedDB queue has kind indexeddb and the documented layout", async () => {
  const factory = new IDBFactory();
  const q = await openIndexedDbQueue(opts(factory, { databaseName: "custom" }));
  try {
    assert.equal(q.kind, "indexeddb");
    await q.put({ signal: "traces", body: "a" });
  } finally {
    q.close();
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open("custom");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    assert.equal(db.version, 1);
    assert.deepEqual([...db.objectStoreNames], [STORE_NAME]);
    const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
    assert.equal(store.keyPath, "id");
    assert.deepEqual([...store.indexNames], ["enqueuedAt"]);
  } finally {
    db.close();
  }
});

test("the default database name is libo11y", async () => {
  const factory = new IDBFactory();
  const q = await openIndexedDbQueue(opts(factory));
  q.close();
  const names = (await factory.databases()).map((d) => d.name);
  assert.deepEqual(names, ["libo11y"]);
});

test("two queues on one database (two tabs) claim disjoint entries", async () => {
  const factory = new IDBFactory();
  const a = await openIndexedDbQueue(opts(factory));
  const b = await openIndexedDbQueue(opts(factory));
  try {
    for (let i = 0; i < 30; i++) await (i % 2 === 0 ? a : b).put({ signal: "logs", body: `e${i}` });
    const claims = await Promise.all([
      a.claim(T0, 7, 60_000),
      b.claim(T0, 7, 60_000),
      a.claim(T0, 7, 60_000),
      b.claim(T0, 7, 60_000),
      a.claim(T0, 7, 60_000),
    ]);
    const ids = claims.flat().map((e) => e.id);
    assert.equal(ids.length, 30);
    assert.equal(new Set(ids).size, 30);
    assert.deepEqual(await a.size(), await b.size());
  } finally {
    a.close();
    b.close();
  }
});

test("entries survive close and reopen", async () => {
  const factory = new IDBFactory();
  const first = await openIndexedDbQueue(opts(factory));
  const stored = await first.put({ signal: "metrics", body: "kept", leaseMillis: 1000 });
  first.close();
  const second = await openIndexedDbQueue(opts(factory));
  try {
    const [entry] = await second.claim(T0 + 1000, 10, 100);
    assert.deepEqual(entry, { ...stored, leaseUntil: T0 + 1100 });
  } finally {
    second.close();
  }
});

test("a versionchange from another context closes the connection, and the next call reopens", async () => {
  const spy = spyFactory(new IDBFactory());
  const q = await openIndexedDbQueue(opts(spy.factory));
  try {
    await q.put({ signal: "traces", body: "before" });
    // Another context upgrades the database; it is not blocked, because the queue closes.
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = spy.factory.open("libo11y", 2);
      req.onblocked = () => reject(new Error("blocked"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    upgraded.close();
    const opensBefore = spy.opens();
    assert.deepEqual(bodiesOf(await q.claim(T0, 10, 100)), ["before"]);
    assert.equal(spy.opens(), opensBefore + 1, "reopened once");
    await q.put({ signal: "traces", body: "after" });
    assert.equal((await q.size()).entries, 2);
    assert.equal(spy.opens(), opensBefore + 1, "and kept the new connection");
  } finally {
    q.close();
  }
});

test("a deleted database is recreated empty on the next call", async () => {
  const factory = new IDBFactory();
  const q = await openIndexedDbQueue(opts(factory));
  try {
    await q.put({ signal: "traces", body: "gone" });
    await new Promise<void>((resolve, reject) => {
      const req = factory.deleteDatabase("libo11y");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("blocked"));
    });
    assert.deepEqual(await q.size(), { entries: 0, bytes: 0 });
    assert.ok(await q.put({ signal: "traces", body: "new" }));
    assert.equal((await q.size()).entries, 1);
  } finally {
    q.close();
  }
});

test("a connection the browser closes is reopened", async () => {
  const spy = spyFactory(new IDBFactory());
  const q = await openIndexedDbQueue(opts(spy.factory));
  try {
    await q.put({ signal: "traces", body: "a" });
    const db = spy.connections[0];
    assert.ok(db);
    forceClose(db);
    assert.equal((await q.size()).entries, 1);
    assert.equal(spy.connections.length, 2);
  } finally {
    q.close();
  }
});

test("when the reopen fails the queue reports it and behaves as an empty memory queue", async () => {
  await withDiag(async (messages) => {
    const spy = spyFactory(new IDBFactory());
    const q = await openIndexedDbQueue(opts(spy.factory));
    try {
      await q.put({ signal: "traces", body: "a" });
      const db = spy.connections[0];
      assert.ok(db);
      spy.failOpens();
      forceClose(db);
      assert.deepEqual(await q.size(), { entries: 0, bytes: 0 });
      assert.ok(messages.some((m) => m.includes("IndexedDB")));
      const opens = spy.opens();
      assert.ok(await q.put({ signal: "traces", body: "b" }));
      assert.deepEqual(bodiesOf(await q.claim(T0, 10, 100)), ["b"]);
      assert.equal(spy.opens(), opens, "the reopen is tried once");
      assert.equal(q.kind, "indexeddb");
    } finally {
      q.close();
    }
  });
});

test("a QuotaExceededError on put evicts the oldest quarter and retries once", async (t) => {
  const factory = new IDBFactory();
  let clock = T0;
  const q = await openIndexedDbQueue(opts(factory, { now: () => clock }));
  t.after(() => q.close());
  for (let i = 0; i < 8; i++) {
    await q.put({ signal: "traces", body: `e${i}` });
    clock++;
  }
  const original = IDBObjectStore.prototype.add;
  let failures = 1;
  IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
    if (failures > 0) {
      failures--;
      throw new DOMException("full", "QuotaExceededError");
    }
    return original.apply(this, args);
  };
  try {
    const stored = await q.put({ signal: "traces", body: "new" });
    assert.equal(stored?.body, "new");
  } finally {
    IDBObjectStore.prototype.add = original;
  }
  assert.deepEqual(bodiesOf(await q.claim(clock, 20, 100)), ["e2", "e3", "e4", "e5", "e6", "e7", "new"]);
});

test("a second QuotaExceededError drops the batch, reported, without rejecting", async (t) => {
  await withDiag(async (messages) => {
    const q = await openIndexedDbQueue(opts(new IDBFactory()));
    t.after(() => q.close());
    await q.put({ signal: "traces", body: "kept" });
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    try {
      assert.equal(await q.put({ signal: "traces", body: "new" }), undefined);
    } finally {
      IDBObjectStore.prototype.add = original;
    }
    assert.deepEqual(await q.size(), { entries: 1, bytes: 4 }, "the aborted retry evicted nothing");
    assert.equal(messages.length, 1);
  });
});

test("a storage failure is reported through diag and resolves as empty or dropped", async (t) => {
  await withDiag(async (messages) => {
    const spy = spyFactory(new IDBFactory());
    const q: PersistentQueue = await openIndexedDbQueue(opts(spy.factory));
    t.after(() => q.close());
    await q.put({ signal: "traces", body: "a" });
    const db = spy.connections[0];
    assert.ok(db);
    const original = db.transaction.bind(db);
    db.transaction = () => {
      throw new DOMException("broken", "UnknownError");
    };
    try {
      assert.equal(await q.put({ signal: "traces", body: "b" }), undefined);
      assert.deepEqual(await q.claim(T0, 10, 100), []);
      assert.equal(await q.nextDue(), undefined);
      assert.deepEqual(await q.size(), { entries: 0, bytes: 0 });
      await q.reschedule("x", T0);
      await q.remove(["x"]);
      await q.clear();
      await q.releaseLeases();
    } finally {
      db.transaction = original;
    }
    assert.equal(messages.length, 8);
    assert.equal((await q.size()).entries, 1, "the connection still works afterwards");
  });
});

test("malformed rows are skipped and removed by claim", async (t) => {
  const factory = new IDBFactory();
  const q = await openIndexedDbQueue(opts(factory));
  t.after(() => q.close());
  await q.put({ signal: "traces", body: "good" });
  const db = await new Promise<IDBDatabase>((resolve) => {
    const req = factory.open("libo11y");
    req.onsuccess = () => resolve(req.result);
  });
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).add({ id: "000000000-bad", enqueuedAt: T0 - 1, body: 42 });
    tx.oncomplete = () => resolve();
  });
  db.close();
  assert.deepEqual(await q.size(), { entries: 1, bytes: 4 });
  assert.deepEqual(bodiesOf(await q.claim(T0, 10, 100)), ["good"]);
});

test("openIndexedDbQueue rejects when IndexedDB is missing or the open fails or is blocked", async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  assert.equal(desc, undefined, "no global indexedDB in this runtime");
  await assert.rejects(openIndexedDbQueue({}), /IndexedDB/);
  await assert.rejects(openIndexedDbQueue({ indexedDB: brokenFactory("error") }), /open failed/);
  await assert.rejects(openIndexedDbQueue({ indexedDB: brokenFactory("blocked") }), /blocked/);
  await assert.rejects(openIndexedDbQueue({ indexedDB: brokenFactory("throw") }), /denied/);
});

test("an open blocked by another connection rejects, and a late success is closed", async () => {
  const factory = new IDBFactory();
  // An old connection at version 1 that ignores versionchange blocks any upgrade.
  const old = await new Promise<IDBDatabase>((resolve) => {
    const req = factory.open("libo11y", 1);
    req.onsuccess = () => resolve(req.result);
  });
  old.onversionchange = null;
  // The queue must upgrade when the store is missing, which the old connection blocks.
  await assert.rejects(openIndexedDbQueue(opts(factory)), /blocked/);
  old.close();
  // Once unblocked, the late upgrade completes and its connection is closed again, so a fresh
  // queue opens without being blocked.
  await new Promise((r) => setTimeout(r, 20));
  const q = await openIndexedDbQueue(opts(factory));
  assert.equal(q.kind, "indexeddb");
  q.close();
});

function bodiesOf(entries: readonly { body: string }[]): string[] {
  return entries.map((e) => e.body);
}
