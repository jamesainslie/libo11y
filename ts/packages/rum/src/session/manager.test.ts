import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "../contracts/session.ts";
import { createChannelHub, createFakeStorage } from "../test-support/fake-storage.ts";
import { localStorageSessionStore } from "./local-store.ts";
import { createSessionManager, type SessionManagerOptions } from "./manager.ts";

const MIN = 60_000;

function setup(
  over: Partial<SessionManagerOptions> = {},
  shared = { storage: createFakeStorage(), hub: createChannelHub() },
) {
  let t = 1_000_000;
  let n = 0;
  const events: SessionEvent[] = [];
  const m = createSessionManager({
    store: localStorageSessionStore({ storage: shared.storage, channel: shared.hub.channel() }),
    sampleRate: () => 0,
    idleMillis: 15 * MIN,
    maxMillis: 240 * MIN,
    now: () => t,
    randomId: () => `id-${++n}`,
    ...over,
  });
  m.subscribe((e) => events.push(e));
  return { m, events, shared, advance: (ms: number) => (t += ms) };
}

test("no session before start, one after", async () => {
  const { m } = setup();
  assert.equal(m.current(), undefined);
  await m.start();
  assert.equal(m.current()?.id, "id-1");
  assert.equal(m.current()?.sampled, false);
  assert.equal(m.kept(), false);
});

test("a sampled session is kept as head_sampled from creation", async () => {
  const { m } = setup({ sampleRate: () => 1 });
  await m.start();
  assert.equal(m.current()?.retained, "head_sampled");
  assert.equal(m.decide(undefined), "send");
});

test("touch extends; 15 minutes idle rotates on the next access", async () => {
  const { m, events, advance } = setup();
  await m.start();
  advance(14 * MIN);
  m.touch();
  advance(14 * MIN);
  assert.equal(m.current()?.id, "id-1");
  advance(MIN);
  assert.equal(m.current()?.id, "id-2");
  assert.deepEqual(
    events.map((e) => [e.type, e.session.id, e.local]),
    [
      ["start", "id-1", true],
      ["end", "id-1", true],
      ["start", "id-2", true],
    ],
  );
});

test("4 hours rotates even with activity", async () => {
  const { m, advance } = setup();
  await m.start();
  for (let i = 0; i < 24; i++) {
    advance(10 * MIN);
    m.touch();
  }
  assert.equal(m.current()?.id, "id-2");
});

test("retain keeps the session once and decide follows it", async () => {
  const { m, events } = setup();
  await m.start();
  assert.equal(m.decide(undefined), "buffer");
  assert.equal(m.retain("error"), true);
  assert.equal(m.retain("frustration"), false);
  assert.equal(m.current()?.retained, "error");
  assert.equal(m.decide("id-1"), "send");
  assert.equal(events.at(-1)?.type, "kept");
});

test("an old unkept session drops, an unknown one drops", async () => {
  const { m, advance } = setup();
  await m.start();
  advance(16 * MIN);
  m.current();
  assert.equal(m.decide("id-1"), "drop");
  assert.equal(m.decide("never-seen"), "drop");
  assert.equal(m.decide("id-2"), "buffer");
});

test("an old kept session still sends", async () => {
  const { m, advance } = setup();
  await m.start();
  m.retain("error");
  advance(16 * MIN);
  m.current();
  assert.equal(m.decide("id-1"), "send");
  assert.equal(m.decide(undefined), "buffer");
});

test("two tabs share one session and hear retention", async () => {
  const a = setup();
  const b = setup({}, a.shared);
  await a.m.start();
  await b.m.start();
  assert.equal(b.m.current()?.id, a.m.current()?.id);
  a.m.retain("frustration");
  assert.equal(b.m.kept(), true);
  // b loaded a's session (start, not local), then heard it become kept.
  assert.deepEqual(
    b.events.map((e) => [e.type, e.local]),
    [
      ["start", false],
      ["kept", false],
    ],
  );
});

test("concurrent rotation converges on the later session", async () => {
  const a = setup();
  const b = setup({ randomId: () => "zzz" }, a.shared);
  await a.m.start();
  await b.m.start();
  a.advance(16 * MIN);
  b.advance(16 * MIN + 5);
  a.m.current(); // a rotates to id-2 at t
  b.m.current(); // b already adopted id-2 through the channel, so it does not rotate
  assert.equal(b.m.current()?.id, a.m.current()?.id);
});

test("an expired stored session is ended by the context that finds it", async () => {
  const storage = createFakeStorage();
  storage.setItem(
    "libo11y.rum.session",
    JSON.stringify({
      v: 1,
      id: "old",
      startedAt: 0,
      lastActivityAt: 0,
      sampled: true,
      retained: "head_sampled",
    }),
  );
  const { m, events } = setup({}, { storage, hub: createChannelHub() });
  await m.start();
  assert.deepEqual(
    events.map((e) => [e.type, e.session.id, e.local]),
    [
      ["end", "old", true],
      ["start", "id-1", true],
    ],
  );
  assert.equal(m.decide("old"), "send");
});

test("clear forgets and removes the session", async () => {
  const { m, shared } = setup();
  await m.start();
  m.clear();
  assert.equal(m.current(), undefined);
  assert.equal(shared.storage.items.size, 0);
});

test("activity saves at most every saveEveryMillis", async () => {
  const { m, shared, advance } = setup({ saveEveryMillis: 5000 });
  await m.start();
  const writes: string[] = [];
  const set = shared.storage.setItem;
  shared.storage.setItem = (k, v) => {
    writes.push(v);
    set(k, v);
  };
  for (let i = 0; i < 10; i++) {
    advance(1000);
    m.touch();
  }
  assert.equal(writes.length, 2);
});

test("no session exists until the stored one has loaded", async () => {
  const storage = createFakeStorage();
  storage.setItem(
    "libo11y.rum.session",
    JSON.stringify({ v: 1, id: "stored", startedAt: 999_000, lastActivityAt: 999_000, sampled: false }),
  );
  const inner = localStorageSessionStore({ storage, channel: createChannelHub().channel() });
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const store = {
    ...inner,
    load: async () => {
      await gate;
      return inner.load();
    },
  };
  const { m } = setup({ store });
  const starting = m.start();
  assert.equal(m.current(), undefined);
  m.touch();
  assert.equal(m.retain("error"), false);
  release();
  await starting;
  assert.equal(m.current()?.id, "stored");
});
