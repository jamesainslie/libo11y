import assert from "node:assert/strict";
import { test } from "node:test";
import { queueConformance } from "../../../web/src/test-support/queue-conformance.ts";
import { fakeStorage } from "../test-support/fake-storage.ts";
import { openStorageQueue } from "./queue.ts";

queueConformance("storage queue", (opts) => openStorageQueue({ ...opts, storage: fakeStorage() }));

const T0 = 1_700_000_000_000;
const INDEX = "libo11y/libo11y/index";
const BODY = "libo11y/libo11y/b/";

test("opening reads only: no write until the first put, which removes orphan bodies", async () => {
  const storage = fakeStorage();
  storage.map.set(`${BODY}orphan`, "x");
  storage.map.set("someone/else", "keep");
  const q = await openStorageQueue({ storage, now: () => T0 });
  await q.size();
  await q.nextDue();
  assert.equal(storage.writes(), 0);
  await q.put({ signal: "traces", body: "{}" });
  assert.equal(storage.map.has(`${BODY}orphan`), false, "orphans go on the first mutation");
  assert.equal(storage.map.get("someone/else"), "keep", "keys outside the queue are left alone");
  assert.ok(storage.writes() > 0);
});

test("put resolves only after the body and the index are saved", async () => {
  const storage = fakeStorage();
  const q = await openStorageQueue({ storage, now: () => T0 });
  const e = await q.put({ signal: "traces", body: "payload" });
  assert.ok(e);
  assert.equal(storage.map.get(`${BODY}${e.id}`), "payload");
  assert.match(storage.map.get(INDEX) ?? "", new RegExp(e.id));
});

test("entries survive a reopen with their attempts and notBefore; leases do not", async () => {
  const storage = fakeStorage();
  const a = await openStorageQueue({ storage, now: () => T0 });
  await a.put({ signal: "logs", body: "one" });
  const second = await a.put({ signal: "traces", body: "two" });
  assert.ok(second);
  await a.reschedule(second.id, T0 + 50);
  const claimed = await a.claim(T0, 10, 30_000);
  assert.deepEqual(
    claimed.map((e) => e.body),
    ["one"],
  );
  a.close();
  const b = await openStorageQueue({ storage, now: () => T0 });
  assert.deepEqual(await b.size(), { entries: 2, bytes: 6 });
  assert.deepEqual(
    (await b.claim(T0, 10, 30_000)).map((e) => e.body),
    ["one"],
    "the lease died with the first queue",
  );
  const [again] = await b.claim(T0 + 50, 10, 30_000);
  assert.equal(again?.body, "two");
  assert.equal(again?.signal, "traces");
  assert.equal(again?.attempts, 1);
});

test("an index entry whose body is gone is dropped on claim", async () => {
  const storage = fakeStorage();
  const q = await openStorageQueue({ storage, now: () => T0 });
  const e = await q.put({ signal: "traces", body: "{}" });
  storage.map.delete(`${BODY}${e?.id}`);
  assert.deepEqual(await q.claim(T0, 10, 1000), []);
  assert.deepEqual(await q.size(), { entries: 0, bytes: 0 });
});

test("a corrupt or foreign index opens as an empty queue", async () => {
  for (const raw of [
    "{not json",
    JSON.stringify({ v: 99, entries: [] }),
    JSON.stringify({ v: 1, entries: [{ id: 3 }] }),
  ]) {
    const storage = fakeStorage();
    storage.map.set(INDEX, raw);
    const q = await openStorageQueue({ storage, now: () => T0 });
    assert.deepEqual(await q.size(), { entries: 0, bytes: 0 }, raw);
  }
});

test("a failing storage never rejects, and a put that failed keeps nothing", async () => {
  const storage = fakeStorage();
  const q = await openStorageQueue({ storage, now: () => T0 });
  storage.fail("setItem");
  assert.equal(await q.put({ signal: "traces", body: "{}" }), undefined);
  assert.deepEqual(await q.size(), { entries: 0, bytes: 0 });
  storage.heal();
  storage.fail("getItem");
  await q.put({ signal: "traces", body: "kept" });
  assert.deepEqual(await q.claim(T0, 10, 1000), [], "an unreadable body is not returned");
  storage.heal();
  storage.fail("removeItem");
  await q.clear();
  await q.remove(["x"]);
  storage.heal();
  storage.fail("getAllKeys");
  await q.clear();
});

test("a failing index read opens an empty queue", async () => {
  const storage = fakeStorage();
  storage.fail("getItem");
  const q = await openStorageQueue({ storage, now: () => T0 });
  assert.deepEqual(await q.size(), { entries: 0, bytes: 0 });
});

test("clear removes every body and the index", async () => {
  const storage = fakeStorage();
  const q = await openStorageQueue({ storage, now: () => T0 });
  await q.put({ signal: "traces", body: "a" });
  await q.put({ signal: "traces", body: "b" });
  await q.clear();
  assert.deepEqual([...storage.map.keys()], []);
});

test("kind is storage and databaseName separates queues", async () => {
  const storage = fakeStorage();
  const a = await openStorageQueue({ storage, databaseName: "a", now: () => T0 });
  const b = await openStorageQueue({ storage, databaseName: "b", now: () => T0 });
  assert.equal(a.kind, "storage");
  await a.put({ signal: "traces", body: "x" });
  await b.put({ signal: "traces", body: "y" });
  assert.deepEqual(await b.size(), { entries: 1, bytes: 1 }, "b's first put kept a's body");
  assert.deepEqual(await a.size(), { entries: 1, bytes: 1 });
  assert.deepEqual(
    (await a.claim(T0, 10, 1)).map((e) => e.body),
    ["x"],
  );
});
