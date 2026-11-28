import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeStorage } from "../test-support/fake-storage.ts";
import { manualTimers } from "../test-support/manual-timers.ts";
import { CONFIG_STORAGE_KEY, createRemoteConfig } from "./remote.ts";

const URL_ = "https://app.test/_o11y/v1/config?service=web";

function body(version: string, config: Record<string, unknown> = {}): string {
  return JSON.stringify({ version, config });
}

function scripted(...responses: (Response | Error)[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init: init ?? {} });
    const r = responses.shift() ?? new Response(null, { status: 500 });
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { f, seen };
}

function client(f: typeof fetch, storage = createFakeStorage(), visible = () => true) {
  const t = manualTimers();
  return {
    t,
    storage,
    c: createRemoteConfig({ url: URL_, refreshMillis: 1000, fetch: f, storage, timers: t.timers, visible }),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

test("a 200 is parsed and cached with its ETag; the next request sends If-None-Match", async () => {
  const { f, seen } = scripted(
    new Response(body("c1", { sessionSampleRate: 0.5 }), { status: 200, headers: { ETag: '"c1"' } }),
    new Response(null, { status: 304 }),
  );
  const { c, storage } = client(f);
  assert.equal(c.current(), undefined);
  assert.equal(await c.refresh(), true);
  assert.deepEqual(c.current(), { version: "c1", sessionSampleRate: 0.5 });
  assert.equal(JSON.parse(storage.items.get(CONFIG_STORAGE_KEY) ?? "{}").etag, '"c1"');
  assert.equal(await c.refresh(), false);
  assert.equal(new Headers(seen[1]?.init.headers).get("If-None-Match"), '"c1"');
  assert.equal(new Headers(seen[0]?.init.headers).get("If-None-Match"), null);
  assert.equal(seen[0]?.url, URL_);
  assert.equal(seen[0]?.init.credentials, "omit");
  assert.equal(seen[0]?.init.cache, "no-cache");
  assert.equal(seen[0]?.init.method ?? "GET", "GET");
});

test("a later page reads the cache synchronously, and an unchanged version is no change", async () => {
  const storage = createFakeStorage();
  const first = client(
    scripted(new Response(body("c1"), { status: 200, headers: { ETag: '"c1"' } })).f,
    storage,
  );
  await first.c.refresh();
  const { f, seen } = scripted(new Response(body("c1"), { status: 200, headers: { ETag: '"c1"' } }));
  const { c } = client(f, storage);
  assert.equal(c.current()?.version, "c1");
  assert.equal(await c.refresh(), false);
  assert.equal(new Headers(seen[0]?.init.headers).get("If-None-Match"), '"c1"');
});

test("without an ETag header the quoted version is the ETag", async () => {
  const { f, seen } = scripted(
    new Response(body("c1"), { status: 200 }),
    new Response(null, { status: 304 }),
  );
  const { c } = client(f);
  await c.refresh();
  await c.refresh();
  assert.equal(new Headers(seen[1]?.init.headers).get("If-None-Match"), '"c1"');
});

test("failures and bad documents keep the cache", async () => {
  const storage = createFakeStorage();
  storage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({ etag: '"c1"', body: { version: "c1", config: {} } }));
  const { f } = scripted(
    new Response("not json", { status: 200 }),
    new Response(JSON.stringify({ version: 3, config: {} }), { status: 200 }),
    new Response(null, { status: 503 }),
    new TypeError("offline"),
  );
  const { c } = client(f, storage);
  for (let i = 0; i < 4; i++) assert.equal(await c.refresh(), false);
  assert.equal(c.current()?.version, "c1");
});

test("a corrupt cache reads as none", () => {
  const storage = createFakeStorage();
  storage.setItem(CONFIG_STORAGE_KEY, "{not json");
  assert.equal(client(scripted().f, storage).c.current(), undefined);
  storage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({ body: { version: 1 } }));
  assert.equal(client(scripted().f, storage).c.current(), undefined);
});

test("a 404 means the app has no configuration any more", async () => {
  const { f } = scripted(new Response(body("c1"), { status: 200 }), new Response(null, { status: 404 }));
  const { c } = client(f);
  await c.refresh();
  assert.equal(await c.refresh(), true);
  assert.equal(c.current(), undefined);
  assert.equal(await c.refresh(), false); // 500 now: still none
});

test("find returns the newest document or the one before it, so a session keeps the version it started under", async () => {
  const storage = createFakeStorage();
  const { f } = scripted(
    new Response(body("c1"), { status: 200 }),
    new Response(body("c2"), { status: 200 }),
  );
  const { c } = client(f, storage);
  await c.refresh();
  await c.refresh();
  assert.equal(c.find("c2")?.version, "c2");
  assert.equal(c.find("c1")?.version, "c1");
  assert.equal(c.find(undefined), undefined);
  assert.equal(c.find("c0")?.version, "c2", "an unknown version falls back to the newest");
  const later = client(scripted().f, storage).c;
  assert.equal(later.find("c1")?.version, "c1", "the earlier document survives a reload");
});

test("clear removes the cache, and a response that arrives after it is not cached", async () => {
  let release: (r: Response) => void = () => {};
  const f = (() => new Promise<Response>((r) => (release = r))) as unknown as typeof fetch;
  const { c, storage } = client(f);
  const pending = c.refresh();
  c.clear();
  release(new Response(body("c1"), { status: 200 }));
  assert.equal(await pending, false);
  assert.equal(storage.items.has(CONFIG_STORAGE_KEY), false);
  assert.equal(c.current(), undefined);
});

test("start refreshes at once, then on the interval only while visible", async () => {
  let visible = true;
  let calls = 0;
  const f = (async () => {
    calls++;
    return new Response(null, { status: 304 });
  }) as unknown as typeof fetch;
  const { c, t } = client(f, createFakeStorage(), () => visible);
  const stop = c.start(() => {});
  await settle();
  t.advance(1000);
  await settle();
  visible = false;
  t.advance(1000);
  await settle();
  stop();
  t.advance(5000);
  await settle();
  assert.equal(calls, 2); // the first refresh at start, one more while visible
});

test("start calls onChange with each new document, and with undefined when it goes away", async () => {
  const { f } = scripted(
    new Response(body("c1"), { status: 200 }),
    new Response(null, { status: 304 }),
    new Response(body("c2", { enabled: false }), { status: 200 }),
    new Response(null, { status: 404 }),
  );
  const { c, t } = client(f);
  const seen: (string | undefined)[] = [];
  const stop = c.start((d) => seen.push(d?.version));
  for (let i = 0; i < 4; i++) {
    await settle();
    t.advance(1000);
  }
  await settle();
  stop();
  assert.deepEqual(seen, ["c1", "c2", undefined]);
});

test("a refresh that never answers does not stack requests", async () => {
  let calls = 0;
  const f = (() => {
    calls++;
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
  const { c, t } = client(f);
  const stop = c.start(() => {});
  t.advance(1000);
  t.advance(1000);
  await settle();
  stop();
  assert.equal(calls, 1);
});
