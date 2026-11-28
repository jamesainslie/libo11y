/** The HTTP transport against a recording fake fetch and sendBeacon. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { SendRequest } from "../contracts/transport.ts";
import type { SignalEndpoints } from "./endpoints.ts";
import { createHttpTransport, type HttpTransportOptions, UNLOAD_BODY_LIMIT } from "./http.ts";

const ENDPOINTS: SignalEndpoints = {
  traces: "https://otel.example.com/v1/traces",
  metrics: "https://otel.example.com/v1/metrics",
  logs: undefined,
};

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

type Answer = Response | Error | (() => Promise<Response>);

// fakeFetch records each call and answers from the script, then 200.
function fakeFetch(...answers: Answer[]): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = answers.shift();
    if (next === undefined) return new Response("{}", { status: 200 });
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    return next;
  }) as typeof fetch & { calls: Call[] };
  f.calls = calls;
  return f;
}

function fakeBeacon(accept = true): ((url: string, data: BodyInit) => boolean) & {
  calls: { url: string; data: BodyInit }[];
} {
  const calls: { url: string; data: BodyInit }[] = [];
  const b = (url: string, data: BodyInit) => {
    calls.push({ url, data });
    return accept;
  };
  return Object.assign(b, { calls });
}

const req = (body: string, mode: SendRequest["mode"] = "normal", signal: SendRequest["signal"] = "traces") =>
  ({ signal, body, mode }) as const;

function transport(overrides: Partial<HttpTransportOptions> & { fetch: typeof fetch }) {
  return createHttpTransport({
    endpoints: ENDPOINTS,
    compression: "none",
    sendBeacon: undefined,
    isOnline: () => true,
    ...overrides,
  });
}

// until polls predicate every few milliseconds, for up to two seconds.
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
}

// randomBody is JSON around n random base-36 characters, which gzip shrinks by about a third only.
function randomBody(n: number): string {
  return JSON.stringify({
    a: Array.from({ length: n }, () => Math.random().toString(36).charAt(2)).join(""),
  });
}

function headersOf(call: Call | undefined): Headers {
  return new Headers(call?.init.headers);
}

async function bodyText(call: Call | undefined): Promise<string> {
  return new Response(call?.init.body ?? null).text();
}

async function gunzipText(body: BodyInit | null | undefined): Promise<string> {
  const stream = new Response(body ?? null).body?.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream ?? null).text();
}

test("a normal send posts JSON to the signal's URL with the configured headers", async () => {
  const f = fakeFetch();
  const t = transport({ fetch: f, headers: { Authorization: "Bearer x" } });
  assert.deepEqual(await t.send(req('{"resourceSpans":[]}')), { kind: "ok" });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call?.url, ENDPOINTS.traces);
  assert.equal(call?.init.method, "POST");
  assert.equal(call?.init.keepalive, undefined);
  assert.ok(call?.init.signal instanceof AbortSignal);
  const h = headersOf(call);
  assert.equal(h.get("content-type"), "application/json");
  assert.equal(h.get("authorization"), "Bearer x");
  assert.equal(h.get("content-encoding"), null);
  assert.equal(await bodyText(call), '{"resourceSpans":[]}');
});

test("gzip compresses the body and sets Content-Encoding", async () => {
  const f = fakeFetch();
  const t = transport({ fetch: f, compression: "gzip" });
  const body = JSON.stringify({ resourceSpans: ["x".repeat(500)] });
  assert.equal((await t.send(req(body))).kind, "ok");
  assert.equal(headersOf(f.calls[0]).get("content-encoding"), "gzip");
  assert.equal(await gunzipText(f.calls[0]?.init.body), body);
});

test("gzip replaces caller content headers regardless of case", async () => {
  const f = fakeFetch();
  const t = transport({
    fetch: f,
    compression: "gzip",
    headers: {
      "content-type": "text/plain",
      "content-encoding": "br",
      Authorization: "Bearer x",
    },
  });
  assert.deepEqual(await t.send(req("{}")), { kind: "ok" });
  const headers = headersOf(f.calls[0]);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("content-encoding"), "gzip");
  assert.equal(headers.get("authorization"), "Bearer x");
  assert.equal(await gunzipText(f.calls[0]?.init.body), "{}");
});

test("compression defaults to gzip", async () => {
  const f = fakeFetch();
  const t = createHttpTransport({
    endpoints: ENDPOINTS,
    fetch: f,
    sendBeacon: undefined,
    isOnline: () => true,
  });
  await t.send(req("{}"));
  assert.equal(headersOf(f.calls[0]).get("content-encoding"), "gzip");
});

test("2xx is ok", async () => {
  for (const status of [200, 202, 204]) {
    const t = transport({ fetch: fakeFetch(new Response(null, { status })) });
    assert.deepEqual(await t.send(req("{}")), { kind: "ok" }, String(status));
  }
});

test("400, 401, 403, 404 and 413 are fatal with the status", async () => {
  for (const status of [400, 401, 403, 404, 413, 500]) {
    const t = transport({ fetch: fakeFetch(new Response("no", { status })) });
    const got = await t.send(req("{}"));
    assert.equal(got.kind, "fatal", String(status));
    assert.equal(got.kind === "fatal" ? got.status : undefined, status);
  }
});

test("408, 429, 502, 503 and 504 are retries", async () => {
  for (const status of [408, 429, 502, 503, 504]) {
    const t = transport({ fetch: fakeFetch(new Response("", { status })) });
    const got = await t.send(req("{}"));
    assert.equal(got.kind, "retry", String(status));
  }
});

test("Retry-After is parsed for 429 and 503", async () => {
  for (const status of [429, 503]) {
    const t = transport({
      fetch: fakeFetch(new Response("", { status, headers: { "Retry-After": "7" } })),
    });
    assert.deepEqual(await t.send(req("{}")), {
      kind: "retry",
      reason: `HTTP ${status}`,
      retryAfterMillis: 7000,
    });
  }
  const t = transport({
    fetch: fakeFetch(new Response("", { status: 429, headers: { "Retry-After": "soon" } })),
  });
  assert.deepEqual(await t.send(req("{}")), { kind: "retry", reason: "HTTP 429" });
});

test("a network error is a retry", async () => {
  const t = transport({ fetch: fakeFetch(new TypeError("Failed to fetch")) });
  const got = await t.send(req("{}"));
  assert.equal(got.kind, "retry");
  assert.match(got.kind === "retry" ? got.reason : "", /network/);
});

test("a timeout aborts the request and is a retry", async () => {
  const f = fakeFetch();
  const hanging = (async (input: RequestInfo | URL, init?: RequestInit) => {
    f.calls.push({ url: String(input), init: init ?? {} });
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  }) as typeof fetch;
  const t = transport({ fetch: hanging, timeoutMillis: 20 });
  const got = await t.send(req("{}"));
  assert.equal(got.kind, "retry");
  assert.match(got.kind === "retry" ? got.reason : "", /timeout/);
  assert.equal(f.calls[0]?.init.signal?.aborted, true);
});

test("the timeout falls back to a timer when AbortSignal.timeout is missing", async () => {
  const saved = AbortSignal.timeout;
  try {
    (AbortSignal as { timeout?: unknown }).timeout = undefined;
    const hanging = (async (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_r, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const got = await transport({ fetch: hanging, timeoutMillis: 20 }).send(req("{}"));
    assert.equal(got.kind, "retry");
    assert.match(got.kind === "retry" ? got.reason : "", /timeout/);
  } finally {
    AbortSignal.timeout = saved;
  }
});

test("the timer fallback needs no DOMException, which bare React Native lacks", async (t) => {
  const savedTimeout = AbortSignal.timeout;
  const savedDom = Object.getOwnPropertyDescriptor(globalThis, "DOMException");
  (AbortSignal as { timeout?: unknown }).timeout = undefined;
  Object.defineProperty(globalThis, "DOMException", { value: undefined, configurable: true, writable: true });
  t.after(() => {
    AbortSignal.timeout = savedTimeout;
    if (savedDom !== undefined) Object.defineProperty(globalThis, "DOMException", savedDom);
  });
  let reason: unknown;
  const hanging = (async (_: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_r, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reason = init.signal?.reason;
        reject(reason);
      });
    })) as typeof fetch;
  const got = await transport({ fetch: hanging, timeoutMillis: 20 }).send(req("{}"));
  assert.equal(got.kind, "retry");
  assert.match(got.kind === "retry" ? got.reason : "", /timeout/);
  assert.ok(reason instanceof Error);
  assert.equal(reason.name, "TimeoutError");
});

test("offline is a retry without a request", async () => {
  const f = fakeFetch();
  const t = transport({ fetch: f, isOnline: () => false });
  assert.deepEqual(await t.send(req("{}")), { kind: "retry", reason: "offline" });
  assert.equal(f.calls.length, 0);
});

test("a signal without a URL is fatal without a request", async () => {
  const f = fakeFetch();
  const got = await transport({ fetch: f }).send(req("{}", "normal", "logs"));
  assert.equal(got.kind, "fatal");
  assert.equal(f.calls.length, 0);
});

test("unload sends by fetch keepalive under the limit", async () => {
  const f = fakeFetch();
  const beacon = fakeBeacon();
  const t = transport({ fetch: f, sendBeacon: beacon });
  assert.deepEqual(await t.send(req("{}", "unload")), { kind: "ok" });
  assert.equal(f.calls[0]?.init.keepalive, true);
  assert.equal(beacon.calls.length, 0);
});

test("unload issues the request synchronously and uncompressed, so a navigation cannot cancel it", async () => {
  // Compression resolves in a later task, after the document may be gone on a real navigation.
  const f = fakeFetch();
  const t = transport({ fetch: f, compression: "gzip" });
  const pending = t.send(req(`{"a":"${"x".repeat(2000)}"}`, "unload"));
  assert.equal(f.calls.length, 1);
  assert.equal(headersOf(f.calls[0]).get("content-encoding"), null);
  assert.equal(f.calls[0]?.init.keepalive, true);
  assert.deepEqual(await pending, { kind: "ok" });
});

test("unload with the keepalive budget in flight uses sendBeacon with a JSON Blob, uncompressed", async () => {
  let release: (r: Response) => void = () => {};
  const f = fakeFetch(() => new Promise<Response>((r) => (release = r)));
  const beacon = fakeBeacon();
  const t = transport({ fetch: f, sendBeacon: beacon, compression: "gzip" });
  // Random bodies gzip cannot shrink much: the first reserves most of the keepalive budget, and the
  // second, compressed, no longer fits what is left, though it fits a beacon uncompressed.
  const noise = randomBody(60_000);
  const big = randomBody(50_000);
  const first = t.send(req(noise, "unload"));
  await until(() => f.calls.length === 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.init.keepalive, true);
  const second = await t.send(req(big, "unload"));
  assert.deepEqual(second, { kind: "ok" });
  assert.equal(f.calls.length, 1);
  assert.equal(beacon.calls.length, 1);
  assert.equal(beacon.calls[0]?.url, ENDPOINTS.traces);
  const blob = beacon.calls[0]?.data;
  assert.ok(blob instanceof Blob);
  assert.match(blob.type, /^application\/json/);
  assert.equal(await blob.text(), big);
  release(new Response(null, { status: 200 }));
  assert.deepEqual(await first, { kind: "ok" });
  // Settled, so the budget is free again.
  assert.deepEqual(await t.send(req("{}", "unload")), { kind: "ok" });
  assert.equal(f.calls.length, 2);
});

test("a beacon the browser refuses is a retry", async () => {
  // An uncompressed body exactly at the limit fills the keepalive budget while it is in flight.
  let release: (r: Response) => void = () => {};
  const held = fakeFetch(() => new Promise<Response>((r) => (release = r)));
  const beacon = fakeBeacon(false);
  const t = transport({ fetch: held, sendBeacon: beacon });
  const first = t.send(req("x".repeat(UNLOAD_BODY_LIMIT), "unload"));
  await new Promise((r) => setTimeout(r, 0));
  const got = await t.send(req("{}", "unload"));
  assert.equal(got.kind, "retry");
  assert.equal(beacon.calls.length, 1);
  release(new Response(null, { status: 200 }));
  await first;
});

test("unload with headers and no keepalive room is an unload budget retry, no beacon", async () => {
  let release: (r: Response) => void = () => {};
  const f = fakeFetch(() => new Promise<Response>((r) => (release = r)));
  const beacon = fakeBeacon();
  const t = transport({ fetch: f, sendBeacon: beacon, headers: { "x-api-key": "k" } });
  const first = t.send(req("x".repeat(UNLOAD_BODY_LIMIT), "unload"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(await t.send(req("{}", "unload")), { kind: "retry", reason: "unload budget" });
  assert.equal(beacon.calls.length, 0);
  release(new Response(null, { status: 200 }));
  await first;
});

test("unload without sendBeacon and no keepalive room is an unload budget retry", async () => {
  const f = fakeFetch();
  const t = transport({ fetch: f, sendBeacon: undefined });
  const got = await t.send(req("x".repeat(UNLOAD_BODY_LIMIT + 1), "unload"));
  assert.deepEqual(got, { kind: "retry", reason: "unload budget" });
  assert.equal(f.calls.length, 0);
});

test("a body over the limit even uncompressed never goes by beacon", async () => {
  const beacon = fakeBeacon();
  const t = transport({ fetch: fakeFetch(), sendBeacon: beacon });
  const got = await t.send(req("x".repeat(UNLOAD_BODY_LIMIT + 1), "unload"));
  assert.deepEqual(got, { kind: "retry", reason: "unload budget" });
  assert.equal(beacon.calls.length, 0);
});

test("a keepalive fetch that fails releases its budget", async () => {
  const f = fakeFetch(new TypeError("Failed to fetch"));
  const beacon = fakeBeacon();
  const t = transport({ fetch: f, sendBeacon: beacon });
  assert.equal((await t.send(req("x".repeat(UNLOAD_BODY_LIMIT), "unload"))).kind, "retry");
  assert.equal((await t.send(req("x".repeat(UNLOAD_BODY_LIMIT), "unload"))).kind, "ok");
  assert.equal(f.calls.length, 2);
  assert.equal(beacon.calls.length, 0);
});

test("send never rejects, even when the fetch throws synchronously", async () => {
  const t = transport({
    fetch: (() => {
      throw new Error("sync");
    }) as unknown as typeof fetch,
  });
  assert.equal((await t.send(req("{}"))).kind, "retry");
});

test("by default exports use pristineFetch, never a fetch patched after load", async () => {
  const received: { method: string; type: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      received.push({ method: req.method ?? "", type: req.headers["content-type"], body });
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const saved = globalThis.fetch;
  let patchedCalls = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    patchedCalls++;
    return saved(...args);
  }) as typeof fetch;
  try {
    const t = createHttpTransport({
      endpoints: { traces: `http://127.0.0.1:${port}/v1/traces`, metrics: undefined, logs: undefined },
      compression: "none",
      isOnline: () => true,
    });
    assert.deepEqual(await t.send(req('{"resourceSpans":[]}')), { kind: "ok" });
  } finally {
    globalThis.fetch = saved;
    await new Promise((r) => server.close(r));
  }
  assert.equal(patchedCalls, 0);
  assert.deepEqual(received, [{ method: "POST", type: "application/json", body: '{"resourceSpans":[]}' }]);
});

test("the request's abort signal aborts the fetch, and the send is a retry", async () => {
  const f = fakeFetch();
  const hanging = (async (input: RequestInfo | URL, init?: RequestInit) => {
    f.calls.push({ url: String(input), init: init ?? {} });
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  }) as typeof fetch;
  const t = transport({ fetch: hanging, timeoutMillis: 60_000 });
  const abort = new AbortController();
  const sent = t.send({ ...req("{}"), abortSignal: abort.signal });
  await new Promise((r) => setTimeout(r, 0));
  abort.abort();
  const got = await sent;
  assert.equal(got.kind, "retry");
  assert.equal(f.calls[0]?.init.signal?.aborted, true);
});

test("without AbortSignal.any the abort signal still aborts the fetch, and a timeout still counts", async () => {
  const saved = AbortSignal.any;
  try {
    (AbortSignal as { any?: unknown }).any = undefined;
    const hanging = (async (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_r, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const abort = new AbortController();
    const sent = transport({ fetch: hanging, timeoutMillis: 60_000 }).send({
      ...req("{}"),
      abortSignal: abort.signal,
    });
    await new Promise((r) => setTimeout(r, 0));
    abort.abort();
    assert.equal((await sent).kind, "retry");
    const timedOut = await transport({ fetch: hanging, timeoutMillis: 20 }).send({
      ...req("{}"),
      abortSignal: new AbortController().signal,
    });
    assert.match(timedOut.kind === "retry" ? timedOut.reason : "", /timeout/);
  } finally {
    AbortSignal.any = saved;
  }
});
