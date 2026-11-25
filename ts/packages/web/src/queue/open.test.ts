import assert from "node:assert/strict";
import { test } from "node:test";
import { type DiagLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { IDBFactory } from "fake-indexeddb";
import { brokenFactory } from "../test-support/queue-conformance.ts";
import { OPEN_TIMEOUT_MILLIS, openQueue, openQueueWithin } from "./open.ts";

async function withDiag(fn: (messages: string[]) => Promise<void>): Promise<void> {
  const messages: string[] = [];
  const push = (msg: string) => {
    messages.push(msg);
  };
  const logger: DiagLogger = { error: push, warn: push, info: push, debug: push, verbose: () => {} };
  diag.setLogger(logger, { logLevel: DiagLogLevel.DEBUG, suppressOverrideMessage: true });
  try {
    await fn(messages);
  } finally {
    diag.disable();
  }
}

test("the open timeout is 3 seconds", () => {
  assert.equal(OPEN_TIMEOUT_MILLIS, 3000);
});

test("openQueue gives the IndexedDB queue when the factory opens", async () => {
  const q = await openQueue({ indexedDB: new IDBFactory() });
  try {
    assert.equal(q.kind, "indexeddb");
    assert.ok(await q.put({ signal: "traces", body: "{}" }));
  } finally {
    q.close();
  }
});

test("without indexedDB openQueue gives a memory queue", async () => {
  assert.equal(Object.getOwnPropertyDescriptor(globalThis, "indexedDB"), undefined);
  await withDiag(async (messages) => {
    const q = await openQueue({ maxEntries: 1 });
    assert.equal(q.kind, "memory");
    await q.put({ signal: "traces", body: "a" });
    await q.put({ signal: "traces", body: "b" });
    assert.equal((await q.size()).entries, 1, "with the given bounds");
    assert.ok(messages.some((m) => m.includes("memory")));
  });
});

test("an open that errors, is blocked or throws gives a memory queue, reported", async () => {
  for (const how of ["error", "blocked", "throw"] as const) {
    await withDiag(async (messages) => {
      const q = await openQueue({ indexedDB: brokenFactory(how) });
      assert.equal(q.kind, "memory", how);
      assert.ok(messages.length > 0, how);
    });
  }
});

test("an open that does not settle within the timeout gives a memory queue", async () => {
  await withDiag(async (messages) => {
    const started = Date.now();
    const q = await openQueueWithin({ indexedDB: brokenFactory("never") }, 30);
    assert.equal(q.kind, "memory");
    assert.ok(Date.now() - started >= 25);
    assert.ok(messages.some((m) => m.includes("30 ms")));
  });
});

test("an open that settles after the timeout is closed, not leaked", async () => {
  const factory = new IDBFactory();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const connections: IDBDatabase[] = [];
  // A factory whose open succeeds only once released.
  const slow = {
    open: (name: string) => {
      const req = factory.open(name);
      return new Proxy(req, {
        set(target, prop, value) {
          if (prop === "onsuccess") {
            (target as unknown as Record<string, unknown>)[prop] = (ev: Event) => {
              connections.push(target.result);
              void gate.then(() => (value as (ev: Event) => void)(ev));
            };
            return true;
          }
          return Reflect.set(target, prop, value);
        },
        get(target, prop) {
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
    deleteDatabase: (name: string) => factory.deleteDatabase(name),
    databases: () => factory.databases(),
    cmp: (a: unknown, b: unknown) => factory.cmp(a, b),
  } as unknown as IDBFactory;
  const q = await openQueueWithin({ indexedDB: slow }, 20);
  assert.equal(q.kind, "memory");
  release();
  await new Promise((r) => setTimeout(r, 20));
  const [late] = connections;
  assert.ok(late);
  // fake-indexeddb marks a closed connection; the late one was closed, not left open.
  assert.equal((late as unknown as { _closePending: boolean })._closePending, true);
});
