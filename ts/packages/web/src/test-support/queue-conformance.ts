/**
 * WP2 (queue and consent). The PersistentQueue conformance suite: every queue (memory, IndexedDB)
 * runs it, so they share one behaviour for order, leases, bounds, expiry and failure. Also the
 * IDBFactory doubles the IndexedDB and openQueue tests use. Tests only;
 * never built.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NewQueueEntry, PersistentQueue, QueueEntry, QueueOptions } from "../contracts/queue.ts";

/** A settable clock for the queue under test. */
export interface Clock {
  now: number;
}

/** Builds a fresh, empty queue under test with the given options, on the given clock. */
export type QueueFactory = (opts: QueueOptions, clock: Clock) => PersistentQueue | Promise<PersistentQueue>;

const T0 = 1_700_000_000_000;

function batch(body: string, extra: Partial<NewQueueEntry> = {}): NewQueueEntry {
  return { signal: "traces", body, ...extra };
}

function bodies(entries: readonly QueueEntry[]): string[] {
  return entries.map((e) => e.body);
}

/**
 * Registers the conformance tests for the queue make builds, prefixed by name. Every test gets a
 * fresh queue whose clock starts at T0, and closes it afterwards.
 */
export function queueConformance(name: string, make: QueueFactory): void {
  async function withQueue(
    opts: QueueOptions,
    fn: (q: PersistentQueue, clock: Clock) => Promise<void>,
  ): Promise<void> {
    const clock: Clock = { now: T0 };
    const q = await make({ ...opts, now: () => clock.now }, clock);
    try {
      await fn(q, clock);
    } finally {
      q.close();
    }
  }

  test(`${name}: put stores an entry with its fields`, () =>
    withQueue({}, async (q, clock) => {
      const e = await q.put({ signal: "logs", body: "héllo" });
      assert.ok(e);
      assert.equal(typeof e.id, "string");
      assert.ok(e.id.length > 0);
      assert.deepEqual(
        { ...e, id: "" },
        {
          id: "",
          signal: "logs",
          body: "héllo",
          bytes: 6,
          enqueuedAt: clock.now,
          attempts: 0,
          notBefore: clock.now,
          leaseUntil: 0,
        },
      );
      const later = await q.put(batch("b", { notBefore: T0 + 500, leaseMillis: 100 }));
      assert.equal(later?.notBefore, T0 + 500);
      assert.equal(later?.leaseUntil, T0 + 100);
      assert.notEqual(later?.id, e.id);
      assert.deepEqual(await q.size(), { entries: 2, bytes: 7 });
    }));

  test(`${name}: claim leases due entries oldest first, up to the limit`, () =>
    withQueue({}, async (q, clock) => {
      for (const b of ["a", "b", "c"]) {
        await q.put(batch(b));
        clock.now += 1;
      }
      await q.put(batch("same ms 1"));
      await q.put(batch("same ms 2"));
      const first = await q.claim(clock.now, 2, 1000);
      assert.deepEqual(bodies(first), ["a", "b"]);
      for (const e of first) assert.equal(e.leaseUntil, clock.now + 1000);
      const second = await q.claim(clock.now, 10, 1000);
      assert.deepEqual(bodies(second), ["c", "same ms 1", "same ms 2"]);
      assert.deepEqual(await q.claim(clock.now, 10, 1000), []);
      assert.deepEqual(await q.claim(clock.now, 0, 1000), []);
      assert.deepEqual(await q.size(), { entries: 5, bytes: 21 }, "claiming removes nothing");
    }));

  test(`${name}: two claims never overlap`, () =>
    withQueue({}, async (q, clock) => {
      for (let i = 0; i < 20; i++) await q.put(batch(`e${i}`));
      const [a, b, c] = await Promise.all([
        q.claim(clock.now, 8, 1000),
        q.claim(clock.now, 8, 1000),
        q.claim(clock.now, 8, 1000),
      ]);
      const ids = [...(a ?? []), ...(b ?? []), ...(c ?? [])].map((e) => e.id);
      assert.equal(ids.length, 20);
      assert.equal(new Set(ids).size, 20);
    }));

  test(`${name}: a lease expires and the entry is claimable again`, () =>
    withQueue({}, async (q, clock) => {
      await q.put(batch("a"));
      assert.equal((await q.claim(clock.now, 10, 500)).length, 1);
      assert.equal((await q.claim(clock.now + 499, 10, 500)).length, 0);
      const again = await q.claim(clock.now + 500, 10, 500);
      assert.deepEqual(bodies(again), ["a"]);
      assert.equal(again[0]?.leaseUntil, clock.now + 1000);
    }));

  test(`${name}: put with leaseMillis stores the entry leased`, () =>
    withQueue({}, async (q, clock) => {
      await q.put(batch("mine", { leaseMillis: 300 }));
      assert.deepEqual(await q.claim(clock.now, 10, 1000), []);
      assert.deepEqual(bodies(await q.claim(clock.now + 300, 10, 1000)), ["mine"]);
    }));

  test(`${name}: notBefore holds an entry back until it is due`, () =>
    withQueue({}, async (q, clock) => {
      await q.put(batch("later", { notBefore: T0 + 1000 }));
      await q.put(batch("now"));
      assert.deepEqual(bodies(await q.claim(clock.now, 10, 100_000)), ["now"]);
      assert.deepEqual(bodies(await q.claim(T0 + 999, 10, 100_000)), []);
      assert.deepEqual(bodies(await q.claim(T0 + 1000, 10, 100_000)), ["later"]);
    }));

  test(`${name}: reschedule counts the attempt, sets notBefore and releases the lease`, () =>
    withQueue({}, async (q, clock) => {
      await q.put(batch("a"));
      const [claimed] = await q.claim(clock.now, 1, 10_000);
      assert.ok(claimed);
      await q.reschedule(claimed.id, T0 + 2000);
      assert.equal(await q.nextDue(), T0 + 2000);
      assert.deepEqual(await q.claim(T0 + 1999, 10, 100), []);
      const [again] = await q.claim(T0 + 2000, 10, 100);
      assert.equal(again?.attempts, 1);
      assert.equal(again?.notBefore, T0 + 2000);
      assert.ok(again);
      await q.reschedule(again.id, T0 + 3000);
      const [third] = await q.claim(T0 + 3000, 10, 100);
      assert.equal(third?.attempts, 2);
      await q.reschedule("no such id", T0);
      assert.deepEqual(await q.size(), { entries: 1, bytes: 1 });
    }));

  test(`${name}: remove deletes the given entries and ignores unknown ids`, () =>
    withQueue({}, async (q, clock) => {
      const a = await q.put(batch("a"));
      const b = await q.put(batch("b"));
      await q.put(batch("c"));
      assert.ok(a && b);
      await q.remove([a.id, "no such id", b.id]);
      await q.remove([]);
      assert.deepEqual(bodies(await q.claim(clock.now, 10, 100)), ["c"]);
      assert.deepEqual(await q.size(), { entries: 1, bytes: 1 });
    }));

  test(`${name}: clear removes every entry, leased or not`, () =>
    withQueue({}, async (q, clock) => {
      await q.put(batch("a"));
      await q.put(batch("b", { leaseMillis: 10_000 }));
      await q.claim(clock.now, 1, 10_000);
      await q.clear();
      assert.deepEqual(await q.size(), { entries: 0, bytes: 0 });
      assert.equal(await q.nextDue(), undefined);
      assert.deepEqual(await q.claim(clock.now + 20_000, 10, 100), []);
    }));

  test(`${name}: releaseLeases makes every leased entry claimable at once, keeping the rest`, () =>
    withQueue({}, async (q, clock) => {
      await q.put(batch("claimed"));
      await q.claim(clock.now, 1, 60_000);
      clock.now += 1;
      await q.put(batch("put leased", { leaseMillis: 60_000 }));
      clock.now += 1;
      await q.put(batch("backing off", { notBefore: T0 + 5000, leaseMillis: 60_000 }));
      await q.put(batch("free"));
      assert.equal(await q.nextDue(), clock.now);
      assert.deepEqual(bodies(await q.claim(clock.now, 10, 1)), ["free"]);
      clock.now += 1;
      await q.releaseLeases();
      const released = await q.claim(clock.now, 10, 60_000);
      assert.deepEqual(bodies(released), ["claimed", "put leased", "free"]);
      for (const e of released) assert.equal(e.attempts, 0, "releasing is not a failed attempt");
      assert.deepEqual(bodies(await q.claim(T0 + 4999, 10, 1)), []);
      assert.deepEqual(bodies(await q.claim(T0 + 5000, 10, 1)), ["backing off"], "notBefore is kept");
      assert.deepEqual(await q.size(), { entries: 4, bytes: 32 }, "releasing removes nothing");
      await q.clear();
      await q.releaseLeases();
      assert.deepEqual(await q.size(), { entries: 0, bytes: 0 });
    }));

  test(`${name}: nextDue is the earliest of each entry's later notBefore and leaseUntil`, () =>
    withQueue({}, async (q) => {
      assert.equal(await q.nextDue(), undefined);
      await q.put(batch("a", { notBefore: T0 + 5000 }));
      assert.equal(await q.nextDue(), T0 + 5000);
      await q.put(batch("b", { leaseMillis: 3000 }));
      assert.equal(await q.nextDue(), T0 + 3000);
      await q.put(batch("c", { notBefore: T0 + 1000, leaseMillis: 4000 }));
      assert.equal(await q.nextDue(), T0 + 3000);
      await q.put(batch("d"));
      assert.equal(await q.nextDue(), T0);
    }));

  test(`${name}: size counts entries and UTF-8 bytes`, () =>
    withQueue({}, async (q) => {
      assert.deepEqual(await q.size(), { entries: 0, bytes: 0 });
      await q.put(batch("abc"));
      await q.put(batch("€"));
      assert.deepEqual(await q.size(), { entries: 2, bytes: 6 });
    }));

  test(`${name}: the byte bound evicts the oldest entries`, () =>
    withQueue({ maxBytes: 10 }, async (q, clock) => {
      await q.put(batch("aaaa"));
      clock.now += 1;
      await q.put(batch("bbbb"));
      clock.now += 1;
      await q.put(batch("cccc"));
      assert.deepEqual(await q.size(), { entries: 2, bytes: 8 });
      clock.now += 1;
      const exact = await q.put(batch("dddddddddd"));
      assert.ok(exact, "a batch of exactly maxBytes is stored");
      assert.deepEqual(bodies(await q.claim(clock.now, 10, 100)), ["dddddddddd"]);
    }));

  test(`${name}: the count bound evicts the oldest entries`, () =>
    withQueue({ maxEntries: 3 }, async (q, clock) => {
      for (const b of ["a", "b", "c", "d", "e"]) {
        await q.put(batch(b));
        clock.now += 1;
      }
      assert.deepEqual(bodies(await q.claim(clock.now, 10, 100)), ["c", "d", "e"]);
    }));

  test(`${name}: the age bound drops old entries on put and on claim`, () =>
    withQueue({ maxAgeMillis: 1000 }, async (q, clock) => {
      await q.put(batch("old"));
      clock.now = T0 + 600;
      await q.put(batch("young"));
      clock.now = T0 + 1000;
      assert.deepEqual(bodies(await q.claim(clock.now, 10, 1)), ["old", "young"], "exactly maxAge is kept");
      clock.now = T0 + 1001;
      await q.put(batch("new"));
      assert.deepEqual(await q.size(), { entries: 2, bytes: 8 }, "put dropped the expired entry");
      assert.deepEqual(bodies(await q.claim(T0 + 1700, 10, 1)), ["new"], "claim dropped the expired entry");
      assert.deepEqual(await q.size(), { entries: 1, bytes: 3 });
    }));

  test(`${name}: a batch larger than maxBytes is refused and changes nothing`, () =>
    withQueue({ maxBytes: 4 }, async (q, clock) => {
      await q.put(batch("ab"));
      assert.equal(await q.put(batch("abcde")), undefined);
      assert.deepEqual(await q.size(), { entries: 1, bytes: 2 });
      assert.deepEqual(bodies(await q.claim(clock.now, 10, 100)), ["ab"]);
    }));

  test(`${name}: the defaults bound the queue at 1000 entries`, () =>
    withQueue({}, async (q, clock) => {
      for (let i = 0; i < 1003; i++) await q.put(batch(`${i}`));
      assert.equal((await q.size()).entries, 1000);
      const [oldest] = await q.claim(clock.now, 1, 100);
      assert.equal(oldest?.body, "3");
    }));

  test(`${name}: after close every method resolves as on an empty queue`, async () => {
    const clock: Clock = { now: T0 };
    const q = await make({ now: () => clock.now }, clock);
    await q.put(batch("a"));
    q.close();
    q.close();
    assert.deepEqual(await q.size(), { entries: 0, bytes: 0 });
    assert.deepEqual(await q.claim(clock.now, 10, 100), []);
    assert.equal(await q.nextDue(), undefined);
    await q.reschedule("x", T0);
    await q.remove(["x"]);
    await q.clear();
    await q.releaseLeases();
    await q.put(batch("after close"));
  });
}

// IndexedDB factory doubles for the queue tests: a spying wrapper over fake-indexeddb, and
// factories whose open errors, blocks or never settles.
/** A factory wrapper that records every connection it opened and can be told to fail opens. */
export interface SpyFactory {
  readonly factory: IDBFactory;
  /** Every database connection a successful open returned, in order. */
  readonly connections: IDBDatabase[];
  /** The number of open calls so far. */
  opens(): number;
  /** Makes every later open fail with an UnknownError. */
  failOpens(): void;
}

/** Wraps inner, recording connections. */
export function spyFactory(inner: IDBFactory): SpyFactory {
  const connections: IDBDatabase[] = [];
  let opens = 0;
  let failing = false;
  const factory = {
    open(name: string, version?: number): IDBOpenDBRequest {
      opens++;
      if (failing) return failingRequest("error");
      const req = version === undefined ? inner.open(name) : inner.open(name, version);
      req.addEventListener("success", () => connections.push(req.result));
      return req;
    },
    deleteDatabase: (name: string) => inner.deleteDatabase(name),
    databases: () => inner.databases(),
    cmp: (a: unknown, b: unknown) => inner.cmp(a, b),
  };
  return {
    factory: factory as IDBFactory,
    connections,
    opens: () => opens,
    failOpens: () => {
      failing = true;
    },
  };
}

type RequestHandlers = {
  error: DOMException | null;
  onerror: ((ev: Event) => void) | null;
  onblocked: ((ev: Event) => void) | null;
  onsuccess: ((ev: Event) => void) | null;
  onupgradeneeded: ((ev: Event) => void) | null;
  addEventListener(): void;
  removeEventListener(): void;
};

// failingRequest is an open request that fires error or blocked on the next tick, or nothing.
function failingRequest(how: "error" | "blocked" | "never"): IDBOpenDBRequest {
  const req: RequestHandlers = {
    error: null,
    onerror: null,
    onblocked: null,
    onsuccess: null,
    onupgradeneeded: null,
    addEventListener() {},
    removeEventListener() {},
  };
  if (how !== "never") {
    setTimeout(() => {
      if (how === "error") {
        req.error = new DOMException("open failed", "UnknownError");
        req.onerror?.(new Event("error"));
      } else {
        req.onblocked?.(new Event("blocked"));
      }
    }, 0);
  }
  return req as unknown as IDBOpenDBRequest;
}

/** A factory whose open fails, is blocked, never settles, or throws at once. */
export function brokenFactory(how: "error" | "blocked" | "never" | "throw"): IDBFactory {
  return {
    open() {
      if (how === "throw") throw new DOMException("denied", "SecurityError");
      return failingRequest(how);
    },
    deleteDatabase() {
      throw new Error("not supported");
    },
    databases: async () => [],
    cmp: () => 0,
  } as unknown as IDBFactory;
}
