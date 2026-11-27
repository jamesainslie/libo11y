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
    shutdown: async () => {},
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
