import assert from "node:assert/strict";
import { test } from "node:test";
import type { Delivery, OtlpBatch } from "@libo11y/web/internal";
import { openQueue } from "@libo11y/web/internal";
import { IDBFactory } from "fake-indexeddb";
import { createRetentionBuffer, RETENTION_QUEUE_DEFAULTS } from "./buffer.ts";

function recordingDelivery(): Delivery & { readonly sent: OtlpBatch[] } {
  const sent: OtlpBatch[] = [];
  return {
    sent,
    async deliver(b) {
      sent.push(b);
      return { outcome: "sent" };
    },
    drain: async () => {},
    clear: async () => {},
    shutdown: async () => ({ timedOut: [] }),
  };
}

test("put then flush hands every batch to delivery once, oldest first", async () => {
  let opened = 0;
  const buffer = createRetentionBuffer({
    open: () => {
      opened++;
      return openQueue({ ...RETENTION_QUEUE_DEFAULTS, indexedDB: new IDBFactory() });
    },
  });
  assert.equal(opened, 0, "nothing is opened before the first use");
  await buffer.put({ signal: "traces", body: "t1" });
  await buffer.put({ signal: "logs", body: "l1" });
  const d = recordingDelivery();
  assert.equal(await buffer.flush(d), 2);
  assert.deepEqual(d.sent, [
    { signal: "traces", body: "t1" },
    { signal: "logs", body: "l1" },
  ]);
  assert.equal(await buffer.flush(d), 0);
  assert.deepEqual(await buffer.size(), { entries: 0, bytes: 0 });
  assert.equal(opened, 1);
  buffer.close();
});

test("two contexts flushing at once send each batch once", async () => {
  const idb = new IDBFactory();
  const a = createRetentionBuffer({ open: () => openQueue({ ...RETENTION_QUEUE_DEFAULTS, indexedDB: idb }) });
  const b = createRetentionBuffer({ open: () => openQueue({ ...RETENTION_QUEUE_DEFAULTS, indexedDB: idb }) });
  for (let i = 0; i < 30; i++) await a.put({ signal: "logs", body: `b${i}` });
  const d = recordingDelivery();
  const [x, y] = await Promise.all([a.flush(d), b.flush(d)]);
  assert.equal(x + y, 30);
  assert.equal(d.sent.length, 30);
  assert.equal(new Set(d.sent.map((s) => s.body)).size, 30);
  a.close();
  b.close();
});

test("the byte bound drops the oldest batches", async () => {
  const buffer = createRetentionBuffer({
    open: () => openQueue({ ...RETENTION_QUEUE_DEFAULTS, maxBytes: 10, indexedDB: new IDBFactory() }),
  });
  await buffer.put({ signal: "logs", body: "aaaaaa" });
  await buffer.put({ signal: "logs", body: "bbbbbb" });
  const d = recordingDelivery();
  await buffer.flush(d);
  assert.deepEqual(
    d.sent.map((s) => s.body),
    ["bbbbbb"],
  );
  buffer.close();
});

test("clear empties the buffer", async () => {
  const buffer = createRetentionBuffer({
    open: () => openQueue({ ...RETENTION_QUEUE_DEFAULTS, indexedDB: new IDBFactory() }),
  });
  await buffer.put({ signal: "logs", body: "x" });
  await buffer.clear();
  assert.equal((await buffer.size()).entries, 0);
  buffer.close();
});

test("size before first use opens nothing", async () => {
  let opened = 0;
  const buffer = createRetentionBuffer({
    open: () => {
      opened++;
      return openQueue({ ...RETENTION_QUEUE_DEFAULTS, indexedDB: new IDBFactory() });
    },
  });
  assert.deepEqual(await buffer.size(), { entries: 0, bytes: 0 });
  assert.equal(opened, 0);
});

test("put never rejects, even when the queue cannot open", async () => {
  const buffer = createRetentionBuffer({ open: () => Promise.reject(new Error("no IndexedDB")) });
  await buffer.put({ signal: "logs", body: "x" });
  await buffer.clear();
  assert.equal(await buffer.flush(recordingDelivery()), 0);
});

test("flush drops the batches keep refuses", async () => {
  const buffer = createRetentionBuffer({
    open: () => openQueue({ ...RETENTION_QUEUE_DEFAULTS, indexedDB: new IDBFactory() }),
  });
  await buffer.put({ signal: "logs", body: "keep" });
  await buffer.put({ signal: "logs", body: "drop" });
  const d = recordingDelivery();
  assert.equal(await buffer.flush(d, (b) => b.body === "keep"), 1);
  assert.deepEqual(
    d.sent.map((s) => s.body),
    ["keep"],
  );
  assert.deepEqual(await buffer.size(), { entries: 0, bytes: 0 });
  buffer.close();
});

test("each batch is removed as soon as it was handed over", async () => {
  const queue = await openQueue({ ...RETENTION_QUEUE_DEFAULTS, indexedDB: new IDBFactory() });
  const buffer = createRetentionBuffer({ open: async () => queue });
  await buffer.put({ signal: "logs", body: "a" });
  await buffer.put({ signal: "logs", body: "b" });
  const sizes: number[] = [];
  const d = recordingDelivery();
  await buffer.flush({
    ...d,
    async deliver(b) {
      sizes.push((await queue.size()).entries);
      return d.deliver(b);
    },
  });
  assert.deepEqual(sizes, [2, 1]);
  buffer.close();
});

test("discard removes only the batches match accepts and leaves the rest claimable", async () => {
  const idb = new IDBFactory();
  const a = createRetentionBuffer({ open: () => openQueue({ ...RETENTION_QUEUE_DEFAULTS, indexedDB: idb }) });
  const b = createRetentionBuffer({ open: () => openQueue({ ...RETENTION_QUEUE_DEFAULTS, indexedDB: idb }) });
  await a.put({ signal: "logs", body: "mine-1" });
  await b.put({ signal: "logs", body: "theirs" });
  await a.put({ signal: "traces", body: "mine-2" });
  assert.equal(await a.discard((batch) => batch.body.startsWith("mine")), 2);
  const d = recordingDelivery();
  assert.equal(await b.flush(d), 1, "the other batch is still claimable at once");
  assert.deepEqual(d.sent, [{ signal: "logs", body: "theirs" }]);
  a.close();
  b.close();
});

test("discard never rejects, even when the queue cannot open", async () => {
  const buffer = createRetentionBuffer({ open: () => Promise.reject(new Error("blocked")) });
  assert.equal(await buffer.discard(() => true), 0);
  buffer.close();
});
