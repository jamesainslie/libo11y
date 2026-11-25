/** The Delivery over the shared doubles, with an injected clock, randomness and timers. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OtlpBatch } from "../contracts/otlp.ts";
import type { NewQueueEntry, QueueEntry } from "../contracts/queue.ts";
import type { DeliveryOptions, SendMode } from "../contracts/transport.ts";
import {
  createFakeGate,
  createFakeQueue,
  createFakeTransport,
  type FakeQueue,
} from "../test-support/index.ts";
import { createDelivery } from "./delivery.ts";

const BATCH: OtlpBatch = { signal: "traces", body: '{"resourceSpans":[]}' };

interface FakeTimers {
  readonly armed: Map<number, { fn: () => void; ms: number }>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The delays of the armed timers. */
  delays(): number[];
  /** Fires every armed timer. */
  fire(): void;
}

function fakeTimers(): FakeTimers {
  const armed = new Map<number, { fn: () => void; ms: number }>();
  let seq = 0;
  return {
    armed,
    setTimer(fn, ms) {
      const id = ++seq;
      armed.set(id, { fn, ms });
      return id;
    },
    clearTimer(handle) {
      armed.delete(handle as number);
    },
    delays: () => [...armed.values()].map((t) => t.ms),
    fire() {
      const all = [...armed.entries()];
      for (const [id, t] of all) {
        armed.delete(id);
        t.fn();
      }
    },
  };
}

// settle lets the promise chains a timer or event started run to completion.
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

function setupDelivery(overrides: Partial<DeliveryOptions> = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const queue = createFakeQueue(now);
  const transport = createFakeTransport();
  const gate = createFakeGate(true);
  const timers = fakeTimers();
  const events = new EventTarget();
  const delivery = createDelivery({
    transport,
    queue,
    gate,
    events,
    isOnline: () => true,
    now,
    random: () => 0.5,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return {
    delivery,
    queue,
    transport,
    gate,
    timers,
    events,
    advance: (ms: number) => {
      clock += ms;
    },
    now,
  };
}

// recordingQueue wraps a fake queue and logs every mutation.
function recordingQueue(inner: FakeQueue, log: string[]): FakeQueue {
  return {
    ...inner,
    entries: inner.entries,
    kind: inner.kind,
    put: async (b: NewQueueEntry) => {
      const e = await inner.put(b);
      log.push(`put${b.leaseMillis === undefined ? "" : " leased"}`);
      return e;
    },
    remove: async (ids: readonly string[]) => {
      log.push(`remove ${ids.length}`);
      return inner.remove(ids);
    },
    reschedule: async (id: string, at: number) => {
      log.push("reschedule");
      return inner.reschedule(id, at);
    },
  };
}

test("an ok attempt is sent and touches no queue", async () => {
  const s = setupDelivery();
  assert.deepEqual(await s.delivery.deliver(BATCH), { outcome: "sent" });
  assert.equal(s.transport.requests.length, 1);
  assert.deepEqual(s.transport.requests[0], { ...BATCH, mode: "normal" });
  assert.equal(s.queue.entries.size, 0);
  assert.equal(s.timers.armed.size, 0);
});

test("with the gate closed the batch is dropped with no request and no queue write", async () => {
  const s = setupDelivery();
  s.gate.set(false);
  const got = await s.delivery.deliver(BATCH);
  assert.deepEqual(got, { outcome: "dropped" });
  assert.equal(s.transport.requests.length, 0);
  assert.equal(s.queue.entries.size, 0);
});

test("a retry with Retry-After queues the batch for then and arms the timer", async () => {
  const s = setupDelivery();
  s.transport.script({ kind: "retry", reason: "HTTP 429", retryAfterMillis: 7000 });
  assert.deepEqual(await s.delivery.deliver(BATCH), { outcome: "queued" });
  const [entry] = [...s.queue.entries.values()];
  assert.equal(entry?.notBefore, s.now() + 7000);
  assert.equal(entry?.body, BATCH.body);
  await settle();
  assert.deepEqual(s.timers.delays(), [7000]);
});

test("a retry without Retry-After queues with backoffDelay(1)", async () => {
  const s = setupDelivery({ initialBackoffMillis: 2000 });
  s.transport.script({ kind: "retry", reason: "network error" });
  assert.equal((await s.delivery.deliver(BATCH)).outcome, "queued");
  // random 0.5 over a 2000 ms cap.
  assert.equal([...s.queue.entries.values()][0]?.notBefore, s.now() + 1000);
});

test("Retry-After is clamped to maxRetryAfterMillis", async () => {
  const s = setupDelivery({ maxRetryAfterMillis: 60_000 });
  s.transport.script({ kind: "retry", reason: "HTTP 503", retryAfterMillis: 86_400_000 });
  await s.delivery.deliver(BATCH);
  assert.equal([...s.queue.entries.values()][0]?.notBefore, s.now() + 60_000);
});

test("a fatal result drops the batch with an error", async () => {
  const s = setupDelivery();
  s.transport.script({ kind: "fatal", reason: "HTTP 400", status: 400 });
  const got = await s.delivery.deliver(BATCH);
  assert.equal(got.outcome, "dropped");
  assert.ok(got.error instanceof Error);
  assert.match(got.error.message, /HTTP 400/);
  assert.equal(s.queue.entries.size, 0);
});

test("a retry without a queue is dropped with an error", async () => {
  const transport = createFakeTransport({ kind: "retry", reason: "offline" });
  const delivery = createDelivery({ transport, gate: createFakeGate(), isOnline: () => true });
  const got = await delivery.deliver(BATCH);
  assert.equal(got.outcome, "dropped");
  assert.ok(got.error instanceof Error);
  await delivery.shutdown();
});

test("offline skips the attempt and queues", async () => {
  const s = setupDelivery({ isOnline: () => false });
  assert.equal((await s.delivery.deliver(BATCH)).outcome, "queued");
  assert.equal(s.transport.requests.length, 0);
  assert.equal(s.queue.entries.size, 1);
});

test("a queue that refuses the batch drops it with an error", async () => {
  const s = setupDelivery();
  const refusing: FakeQueue = { ...s.queue, entries: s.queue.entries, put: async () => undefined };
  const transport = createFakeTransport({ kind: "retry", reason: "HTTP 502" });
  const d = createDelivery({ transport, queue: refusing, gate: s.gate, isOnline: () => true });
  const got = await d.deliver(BATCH);
  assert.equal(got.outcome, "dropped");
  assert.ok(got.error instanceof Error);
  await d.shutdown();
});

test("persistFirst puts leased, sends, and removes on ok", async () => {
  const log: string[] = [];
  const s = setupDelivery();
  const queue = recordingQueue(s.queue, log);
  const d = createDelivery({
    transport: s.transport,
    queue,
    gate: s.gate,
    persistFirst: true,
    isOnline: () => true,
  });
  assert.deepEqual(await d.deliver(BATCH), { outcome: "sent" });
  assert.deepEqual(log, ["put leased", "remove 1"]);
  assert.equal(s.transport.requests.length, 1);
  assert.equal(s.queue.entries.size, 0);
  await d.shutdown();
});

test("persistFirst removes on fatal and reschedules on retry", async () => {
  const log: string[] = [];
  const s = setupDelivery();
  const queue = recordingQueue(s.queue, log);
  s.transport.script({ kind: "fatal", reason: "HTTP 413", status: 413 });
  s.transport.script({ kind: "retry", reason: "HTTP 429", retryAfterMillis: 5000 });
  const d = createDelivery({
    transport: s.transport,
    queue,
    gate: s.gate,
    persistFirst: true,
    isOnline: () => true,
    now: s.now,
    setTimer: s.timers.setTimer,
    clearTimer: s.timers.clearTimer,
  });
  const fatal = await d.deliver(BATCH);
  assert.equal(fatal.outcome, "dropped");
  assert.ok(fatal.error);
  assert.deepEqual(await d.deliver(BATCH), { outcome: "queued" });
  assert.deepEqual(log, ["put leased", "remove 1", "put leased", "reschedule"]);
  const [entry] = [...s.queue.entries.values()];
  assert.equal(entry?.leaseUntil, 0);
  assert.equal(entry?.attempts, 1);
  assert.equal(entry?.notBefore, s.now() + 5000);
  await d.shutdown();
});

test("persistFirst still sends once when put stores nothing", async () => {
  const s = setupDelivery();
  const refusing: FakeQueue = { ...s.queue, entries: s.queue.entries, put: async () => undefined };
  const d = createDelivery({
    transport: s.transport,
    queue: refusing,
    gate: s.gate,
    persistFirst: true,
    isOnline: () => true,
  });
  assert.deepEqual(await d.deliver(BATCH), { outcome: "sent" });
  assert.equal(s.transport.requests.length, 1);
  await d.shutdown();
});

test("persistFirst offline stores the batch claimable and sends nothing", async () => {
  const s = setupDelivery({ persistFirst: true, isOnline: () => false });
  assert.deepEqual(await s.delivery.deliver(BATCH), { outcome: "queued" });
  assert.equal(s.transport.requests.length, 0);
  const [entry] = [...s.queue.entries.values()];
  assert.equal(entry?.leaseUntil, 0);
  assert.ok((entry?.notBefore ?? Infinity) <= s.now());
});

async function seed(
  queue: FakeQueue,
  advance: (ms: number) => void,
  bodies: string[],
): Promise<QueueEntry[]> {
  const out: QueueEntry[] = [];
  for (const body of bodies) {
    const e = await queue.put({ signal: "logs", body });
    if (e) out.push(e);
    advance(1);
  }
  return out;
}

test("drain sends due entries oldest first, removes them, and arms no timer when empty", async () => {
  const s = setupDelivery({ drainBatch: 2 });
  await seed(s.queue, s.advance, ["a", "b", "c"]);
  await s.queue.put({ signal: "logs", body: "later", notBefore: s.now() + 60_000 });
  await s.delivery.drain();
  assert.deepEqual(
    s.transport.requests.map((r) => r.body),
    ["a", "b", "c"],
  );
  assert.ok(s.transport.requests.every((r) => r.mode === "normal" && r.signal === "logs"));
  assert.deepEqual(
    [...s.queue.entries.values()].map((e) => e.body),
    ["later"],
  );
  assert.deepEqual(s.timers.delays(), [60_000]);
});

test("drain reschedules a retry with Retry-After, else backoff on attempts + 1, and re-arms one timer", async () => {
  const s = setupDelivery({ initialBackoffMillis: 1000, random: () => 1 });
  const [a, b] = await seed(s.queue, s.advance, ["a", "b"]);
  assert.ok(a && b);
  await s.queue.reschedule(b.id, s.now());
  s.transport.script(
    { kind: "retry", reason: "HTTP 429", retryAfterMillis: 9000 },
    { kind: "retry", reason: "network error" },
  );
  await s.delivery.drain();
  assert.equal(s.queue.entries.get(a.id)?.notBefore, s.now() + 9000);
  // b had one failed attempt; this is retry 2: cap 2000, random 1.
  assert.equal(s.queue.entries.get(b.id)?.notBefore, s.now() + 2000);
  assert.equal(s.queue.entries.get(b.id)?.attempts, 2);
  assert.deepEqual(s.timers.delays(), [2000]);
  // Firing the timer drains again; draining twice keeps exactly one timer.
  s.advance(2000);
  s.timers.fire();
  await settle();
  assert.equal(s.transport.requests.length, 3);
  assert.deepEqual(s.timers.delays(), [7000]);
});

test("a fatal result during drain removes the entry", async () => {
  const s = setupDelivery();
  await seed(s.queue, s.advance, ["a"]);
  s.transport.script({ kind: "fatal", reason: "HTTP 400", status: 400 });
  await s.delivery.drain();
  assert.equal(s.queue.entries.size, 0);
});

test("the online event drains", async () => {
  const s = setupDelivery();
  await seed(s.queue, s.advance, ["a"]);
  s.events.dispatchEvent(new Event("online"));
  await settle();
  assert.equal(s.transport.requests.length, 1);
  assert.equal(s.queue.entries.size, 0);
});

test("the gate opening drains, and drain is a no-op while it is closed", async () => {
  const s = setupDelivery();
  await seed(s.queue, s.advance, ["a"]);
  s.gate.set(false);
  await s.delivery.drain();
  assert.equal(s.transport.requests.length, 0);
  s.gate.set(true);
  await settle();
  assert.equal(s.transport.requests.length, 1);
});

test("drain is a no-op in unload mode and while offline", async () => {
  let mode: SendMode = "unload";
  let online = true;
  const s = setupDelivery({ mode: () => mode, isOnline: () => online });
  await seed(s.queue, s.advance, ["a"]);
  await s.delivery.drain();
  assert.equal(s.transport.requests.length, 0);
  mode = "normal";
  online = false;
  await s.delivery.drain();
  assert.equal(s.transport.requests.length, 0);
  online = true;
  await s.delivery.drain();
  assert.equal(s.transport.requests.length, 1);
});

test("deliver in unload mode sends in unload mode", async () => {
  const s = setupDelivery({ mode: () => "unload" });
  await s.delivery.deliver(BATCH);
  assert.equal(s.transport.requests[0]?.mode, "unload");
});

test("one drain runs at a time", async () => {
  const s = setupDelivery();
  await seed(s.queue, s.advance, ["a", "b"]);
  await Promise.all([s.delivery.drain(), s.delivery.drain(), s.delivery.drain()]);
  assert.equal(s.transport.requests.length, 2);
});

test("drain stops when the gate closes mid-round", async () => {
  const s = setupDelivery();
  await seed(s.queue, s.advance, ["a", "b", "c"]);
  const send = s.transport.send.bind(s.transport);
  const gated = {
    ...s.transport,
    send: async (req: Parameters<typeof send>[0]) => {
      const r = await send(req);
      s.gate.set(false);
      return r;
    },
  };
  const d = createDelivery({ transport: gated, queue: s.queue, gate: s.gate, isOnline: () => true });
  await d.drain();
  assert.equal(s.transport.requests.length, 1);
  await d.shutdown();
});

test("clear empties the queue and cancels the timer", async () => {
  const s = setupDelivery();
  s.transport.script({ kind: "retry", reason: "HTTP 503", retryAfterMillis: 1000 });
  await s.delivery.deliver(BATCH);
  await settle();
  assert.equal(s.timers.armed.size, 1);
  await s.delivery.clear();
  assert.equal(s.queue.entries.size, 0);
  assert.equal(s.timers.armed.size, 0);
});

test("clear waits for a running drain round", async () => {
  const s = setupDelivery();
  await seed(s.queue, s.advance, ["a"]);
  let release: () => void = () => {};
  const slow = {
    send: async () => {
      await new Promise<void>((r) => (release = r));
      return { kind: "retry", reason: "HTTP 503" } as const;
    },
  };
  const d = createDelivery({
    transport: slow,
    queue: s.queue,
    gate: s.gate,
    isOnline: () => true,
    setTimer: s.timers.setTimer,
    clearTimer: s.timers.clearTimer,
  });
  const draining = d.drain();
  await settle();
  let cleared = false;
  const clearing = d.clear().then(() => {
    cleared = true;
  });
  await settle();
  assert.equal(cleared, false);
  release();
  await Promise.all([draining, clearing]);
  assert.equal(s.queue.entries.size, 0);
  assert.equal(s.timers.armed.size, 0);
  await d.shutdown();
});

test("shutdown cancels the timer, stops listening, and leaves entries", async () => {
  const s = setupDelivery();
  s.transport.script({ kind: "retry", reason: "HTTP 503", retryAfterMillis: 1000 });
  await s.delivery.deliver(BATCH);
  await settle();
  await s.delivery.shutdown();
  assert.equal(s.timers.armed.size, 0);
  assert.equal(s.queue.entries.size, 1);
  s.advance(5000);
  s.events.dispatchEvent(new Event("online"));
  s.gate.set(false);
  s.gate.set(true);
  await settle();
  assert.equal(s.transport.requests.length, 1);
});

test("deliver never rejects when the transport or queue throws", async () => {
  const s = setupDelivery();
  const throwing = {
    send: async () => {
      throw new Error("boom");
    },
  };
  const d = createDelivery({ transport: throwing, queue: s.queue, gate: s.gate, isOnline: () => true });
  const got = await d.deliver(BATCH);
  assert.equal(got.outcome, "dropped");
  assert.ok(got.error);
  await d.shutdown();
});
