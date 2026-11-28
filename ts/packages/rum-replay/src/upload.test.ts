import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { manualTimers } from "../../rum/src/test-support/manual-timers.ts";
import type { SegmentEnvelope } from "./envelope.ts";
import { createUploader, gzipJson, KEEPALIVE_MAX_BYTES, type Uploader } from "./upload.ts";

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";

function envelope(n: number, pad = 0): SegmentEnvelope {
  return {
    format: 1,
    recording: "rec-0001",
    start: n,
    end: n,
    views: [],
    requests: [],
    events: [{ type: 3, timestamp: n, data: { source: 1, positions: [], pad: "x".repeat(pad) } }],
  };
}

interface Sent {
  readonly url: URL;
  readonly init: RequestInit;
  readonly body: unknown;
}

function setup(
  o: { responses?: (Response | Error)[]; allowed?: (s: string) => boolean; clientToken?: string } = {},
) {
  const clock = manualTimers(1_700_000_000_000);
  const sent: Sent[] = [];
  const responses = o.responses ?? [];
  const counters = new Map<string, number>();
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(gunzipSync(init.body as Uint8Array).toString("utf8"));
    sent.push({ url: new URL(url), init, body });
    const r = responses.shift() ?? new Response(null, { status: 204 });
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof globalThis.fetch;
  const up: Uploader = createUploader({
    url: "https://app.test/_o11y/v1/replay",
    service: "shop",
    ...(o.clientToken === undefined ? {} : { clientToken: o.clientToken }),
    fetch,
    allocate: async (s) => {
      const n = counters.get(s) ?? 0;
      counters.set(s, n + 1);
      return n;
    },
    now: () => clock.now(),
    allowed: o.allowed ?? (() => true),
    timers: clock.timers,
    maxQueue: 4,
    maxQueueBytes: 4_194_304,
  });
  return { up, sent, clock };
}

/** Lets compression, allocation and fetch settle: CompressionStream runs on real tasks, so this waits on timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));
}

test("gzipJson round-trips through gunzip", async () => {
  const bytes = await gzipJson({ a: [1, "b"] });
  assert.deepEqual(JSON.parse(gunzipSync(bytes).toString("utf8")), { a: [1, "b"] });
});

test("a segment posts gzipped JSON once, with the wire parameters and no credentials", async () => {
  const { up, sent } = setup({ clientToken: "pub-1" });
  up.enqueue(SESSION, envelope(1));
  await settle();
  assert.equal(sent.length, 1);
  const s = sent[0];
  assert.ok(s);
  assert.equal(s.url.origin + s.url.pathname, "https://app.test/_o11y/v1/replay");
  assert.deepEqual(Object.fromEntries(s.url.searchParams), {
    service: "shop",
    session: SESSION,
    segment: "0",
    sent_at: "1700000000000",
    client_token: "pub-1",
  });
  assert.equal(s.init.method, "POST");
  assert.equal(s.init.credentials, "omit");
  assert.equal(s.init.keepalive, true);
  const headers = new Headers(s.init.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("content-encoding"), "gzip");
  assert.deepEqual(s.body, envelope(1));
  assert.equal(up.currentSegment(SESSION), 0);
  assert.equal(up.currentSegment("other"), undefined);
});

test("without a client token the query has none", async () => {
  const { up, sent } = setup();
  up.enqueue(SESSION, envelope(1));
  await settle();
  assert.equal(sent[0]?.url.searchParams.has("client_token"), false);
});

test("segments go one at a time, in order, numbered 0 and 1", async () => {
  const { up, sent } = setup();
  up.enqueue(SESSION, envelope(1));
  up.enqueue(SESSION, envelope(2));
  await settle();
  assert.deepEqual(
    sent.map((s) => [s.url.searchParams.get("segment"), (s.body as SegmentEnvelope).start]),
    [
      ["0", 1],
      ["1", 2],
    ],
  );
  assert.equal(up.currentSegment(SESSION), 1);
});

test("a 503 with Retry-After retries then with the same segment and a new sent_at; a third 503 drops it", async () => {
  const busy = () => new Response(null, { status: 503, headers: { "Retry-After": "2" } });
  const { up, sent, clock } = setup({ responses: [busy(), busy(), busy()] });
  up.enqueue(SESSION, envelope(1));
  up.enqueue(SESSION, envelope(2));
  await settle();
  assert.equal(sent.length, 1);
  clock.advance(1999);
  await settle();
  assert.equal(sent.length, 1);
  clock.advance(1);
  await settle();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.url.searchParams.get("segment"), "0");
  assert.equal(sent[1]?.url.searchParams.get("sent_at"), String(1_700_000_002_000));
  clock.advance(2000);
  await settle();
  assert.equal(sent.length, 4, "the third 503 dropped segment 0, and segment 1 went next");
  assert.deepEqual(
    sent.map((s) => s.url.searchParams.get("segment")),
    ["0", "0", "0", "1"],
  );
});

test("a 429 without Retry-After waits 5 s, and a Retry-After above 60 s waits 60 s", async () => {
  const { up, sent, clock } = setup({
    responses: [
      new Response(null, { status: 429 }),
      new Response(null, { status: 429, headers: { "Retry-After": "600" } }),
    ],
  });
  up.enqueue(SESSION, envelope(1));
  await settle();
  clock.advance(4999);
  await settle();
  assert.equal(sent.length, 1);
  clock.advance(1);
  await settle();
  assert.equal(sent.length, 2);
  clock.advance(59_999);
  await settle();
  assert.equal(sent.length, 2);
  clock.advance(1);
  await settle();
  assert.equal(sent.length, 3);
});

test("a 400 drops the segment at once", async () => {
  const { up, sent, clock } = setup({ responses: [new Response(null, { status: 400 })] });
  up.enqueue(SESSION, envelope(1));
  up.enqueue(SESSION, envelope(2));
  await settle();
  clock.advance(60_000);
  await settle();
  assert.deepEqual(
    sent.map((s) => s.url.searchParams.get("segment")),
    ["0", "1"],
  );
});

test("a network error retries, then drops after three attempts", async () => {
  const { up, sent, clock } = setup({
    responses: [new TypeError("offline"), new TypeError("offline"), new TypeError("offline")],
  });
  up.enqueue(SESSION, envelope(1));
  await settle();
  for (let i = 0; i < 3; i++) {
    clock.advance(5000);
    await settle();
  }
  assert.equal(sent.length, 3);
});

test("a segment whose session may not upload is dropped and nothing is numbered", async () => {
  const numbered: string[] = [];
  const { up, sent } = setup({ allowed: (s) => s !== SESSION });
  up.enqueue(SESSION, envelope(1));
  await settle();
  assert.equal(sent.length, 0);
  assert.equal(up.currentSegment(SESSION), undefined);
  assert.deepEqual(numbered, []);
});

test("past maxQueue the oldest unsent segment is dropped", async () => {
  const { up, sent, clock } = setup({
    responses: [new Response(null, { status: 503, headers: { "Retry-After": "1" } })],
  });
  for (let i = 1; i <= 6; i++) up.enqueue(SESSION, envelope(i));
  await settle();
  clock.advance(1000);
  await settle();
  // Segment 1 is in flight; 2 and 3 were dropped for 4, 5 and 6.
  assert.deepEqual(
    sent.map((s) => (s.body as SegmentEnvelope).start),
    [1, 1, 4, 5, 6],
  );
});

test("past maxQueueBytes the oldest unsent segment is dropped", async () => {
  const clock = manualTimers(0);
  const sent: number[] = [];
  let release: (() => void) | undefined;
  const up = createUploader({
    url: "https://app.test/_o11y/v1/replay",
    service: "shop",
    fetch: (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(gunzipSync(init.body as Uint8Array).toString("utf8")).start);
      await new Promise<void>((r) => {
        release = r;
      });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch,
    allocate: async () => 0,
    now: () => clock.now(),
    allowed: () => true,
    timers: clock.timers,
    maxQueue: 4,
    maxQueueBytes: 1,
  });
  up.enqueue(SESSION, envelope(1));
  up.enqueue(SESSION, envelope(2));
  up.enqueue(SESSION, envelope(3));
  await settle();
  release?.();
  await settle();
  release?.();
  await settle();
  assert.deepEqual(sent, [1, 3]);
});

test("clear drops what is queued and forgets the current segment", async () => {
  const { up, sent, clock } = setup({
    responses: [new Response(null, { status: 503, headers: { "Retry-After": "1" } })],
  });
  up.enqueue(SESSION, envelope(1));
  up.enqueue(SESSION, envelope(2));
  await settle();
  up.clear();
  clock.advance(5000);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(up.currentSegment(SESSION), undefined);
});

test("a body over the keepalive quota is sent without keepalive", async () => {
  const { up, sent } = setup();
  // Random padding does not compress below the quota.
  const pad = randomBytes(KEEPALIVE_MAX_BYTES * 2).toString("hex");
  up.enqueue(SESSION, { ...envelope(1), events: [{ type: 3, timestamp: 1, data: { source: 1, pad } }] });
  const deadline = Date.now() + 5000;
  while (sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent[0]?.init.keepalive, false);
});
