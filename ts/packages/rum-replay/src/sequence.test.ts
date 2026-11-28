import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeStorage } from "../../rum/src/test-support/fake-storage.ts";
import { allocateSegment, clearSequence, type LockManagerLike, SEQUENCE_KEY } from "./sequence.ts";

/** A lock manager that runs callbacks one at a time, as navigator.locks does for one name. */
function serialLocks(): LockManagerLike & { readonly names: string[] } {
  let tail: Promise<unknown> = Promise.resolve();
  const names: string[] = [];
  return {
    names,
    request<T>(name: string, cb: () => Promise<T> | T): Promise<T> {
      names.push(name);
      const run = tail.then(() => new Promise<void>((r) => setTimeout(r, 0))).then(cb);
      tail = run.catch(() => {});
      return run;
    },
  };
}

test("indexes start at 0 and increase per session", async () => {
  const storage = createFakeStorage();
  const locks = serialLocks();
  assert.deepEqual(
    [await allocateSegment("s1", storage, locks), await allocateSegment("s1", storage, locks)],
    [0, 1],
  );
  assert.equal(await allocateSegment("s2", storage, locks), 0);
  assert.deepEqual(JSON.parse(storage.getItem(SEQUENCE_KEY) ?? ""), { session: "s2", next: 1 });
  assert.deepEqual(new Set(locks.names), new Set(["libo11y.rum.replay.seq"]));
});

test("concurrent allocations under the lock never collide", async () => {
  const storage = createFakeStorage();
  const locks = serialLocks();
  const got = await Promise.all(Array.from({ length: 20 }, () => allocateSegment("s1", storage, locks)));
  assert.deepEqual(
    [...got].sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, i) => i),
  );
});

test("two tabs sharing storage share one counter", async () => {
  const storage = createFakeStorage();
  const locks = serialLocks();
  const a = allocateSegment("s1", storage, locks);
  const b = allocateSegment("s1", storage, locks);
  assert.deepEqual((await Promise.all([a, b])).sort(), [0, 1]);
});

test("an unreadable or foreign counter restarts at 0", async () => {
  for (const bad of [
    "{not json",
    '{"session":"s1","next":-1}',
    '{"session":"s1","next":1.5}',
    "[]",
    "null",
  ]) {
    const storage = createFakeStorage();
    storage.setItem(SEQUENCE_KEY, bad);
    assert.equal(await allocateSegment("s1", storage, serialLocks()), 0, bad);
  }
});

test("a storage that throws still gives this tab increasing indexes", async () => {
  const storage = {
    getItem: (): string | null => {
      throw new Error("denied");
    },
    setItem: (): void => {
      throw new Error("denied");
    },
  };
  const locks = serialLocks();
  assert.deepEqual(
    [await allocateSegment("s1", storage, locks), await allocateSegment("s1", storage, locks)],
    [0, 1],
  );
  assert.equal(await allocateSegment("s2", storage, locks), 0);
});

test("clearSequence removes the counter", async () => {
  const storage = createFakeStorage();
  await allocateSegment("s1", storage, serialLocks());
  clearSequence(storage);
  assert.equal(storage.getItem(SEQUENCE_KEY), null);
});
