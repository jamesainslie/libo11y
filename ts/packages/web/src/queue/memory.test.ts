import assert from "node:assert/strict";
import { test } from "node:test";
import { queueConformance } from "../test-support/queue-conformance.ts";
import { createMemoryQueue } from "./memory.ts";

queueConformance("memory", (opts) => createMemoryQueue(opts));

test("the memory queue has kind memory and ignores databaseName and indexedDB", async () => {
  const q = createMemoryQueue({ databaseName: "x", indexedDB: {} as IDBFactory });
  assert.equal(q.kind, "memory");
  assert.ok(await q.put({ signal: "metrics", body: "{}" }));
  q.close();
});

test("two memory queues share nothing", async () => {
  const a = createMemoryQueue();
  const b = createMemoryQueue();
  await a.put({ signal: "traces", body: "a" });
  assert.deepEqual(await b.size(), { entries: 0, bytes: 0 });
});

test("the memory queue defaults to Date.now", async () => {
  const before = Date.now();
  const e = await createMemoryQueue().put({ signal: "traces", body: "a" });
  assert.ok(e && e.enqueuedAt >= before && e.enqueuedAt <= Date.now());
});
