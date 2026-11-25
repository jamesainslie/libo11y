/**
 * WP1. The HTTP transport and the Delivery in Chromium against the fixture server's sink: gzip on
 * the wire, a cross-origin preflight, Retry-After, keepalive and beacon sends that survive a
 * navigation, and offline then online.
 */
import { expect, type Page, test } from "@playwright/test";
import type { TransportPage } from "./fixtures/transport-page.ts";
import { createSink } from "./harness/sink.ts";

const EMPTY = { resourceSpans: [] };

async function open(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/page/transport-page");
  await page.waitForFunction(() => (globalThis as { __transport?: unknown }).__transport !== undefined);
  expect(errors).toEqual([]);
}

/** Runs fn in the page with the TransportPage and arg. fn must not close over anything. */
function drive<A, T>(page: Page, fn: (t: TransportPage, arg: A) => T | Promise<T>, arg: A): Promise<T> {
  return page.evaluate(`(${fn.toString()})(globalThis.__transport, ${JSON.stringify(arg)})`) as Promise<T>;
}

test("a gzip body arrives with Content-Encoding gzip and decodes", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await open(page);
  const body = JSON.stringify({ resourceSpans: [], pad: "a".repeat(4000) });
  const result = await drive(
    page,
    (t, a) => {
      t.create("t", { endpoint: a.endpoint });
      return t.send("t", a.body, "normal");
    },
    { endpoint: sink.endpoint, body },
  );
  expect(result).toEqual({ kind: "ok" });
  const [got] = await sink.waitFor((r) => r.length === 1);
  expect(got?.encoding).toBe("gzip");
  expect(got?.contentType).toBe("application/json");
  expect(got?.bytes).toBeLessThan(body.length / 10);
  expect(got?.body).toEqual(JSON.parse(body));
});

test("a cross-origin collector passes the preflight with headers", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await open(page);
  const result = await drive(
    page,
    (t, a) => {
      t.create("t", { endpoint: a.endpoint, headers: { "x-api-key": "k" } });
      return t.send("t", a.body, "normal");
    },
    { endpoint: sink.crossOriginEndpoint, body: JSON.stringify(EMPTY) },
  );
  expect(result).toEqual({ kind: "ok" });
  const [got] = await sink.waitFor((r) => r.length === 1);
  expect(got?.origin).toBe(new URL(baseURL ?? "").origin);
  expect(got?.encoding).toBe("gzip");
  expect(got?.body).toEqual(EMPTY);
});

test("429 with Retry-After: 1 is retried after at least a second and delivered once", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await sink.script([{ status: 429, retryAfter: "1" }]);
  await open(page);
  const outcome = await drive(
    page,
    (t, a) => {
      t.create("t", { endpoint: a.endpoint });
      t.createDelivery("t");
      return t.deliver("t", a.body);
    },
    { endpoint: sink.crossOriginEndpoint, body: JSON.stringify(EMPTY) },
  );
  expect(outcome).toBe("queued");
  const got = await sink.waitFor((r) => r.length === 2);
  expect(got.map((r) => r.body)).toEqual([EMPTY, EMPTY]);
  await expect.poll(() => drive(page, (t) => t.queued("t"), null)).toBe(0);
  const attempts = await drive(page, (t) => t.attempts("t"), null);
  expect(attempts.map((a) => a.result.kind)).toEqual(["retry", "ok"]);
  // Retry-After crossed origins only because the sink exposes it.
  expect(attempts[0]?.result).toMatchObject({ retryAfterMillis: 1000 });
  expect((attempts[1]?.at ?? 0) - (attempts[0]?.at ?? 0)).toBeGreaterThanOrEqual(1000);
  await page.waitForTimeout(500);
  expect((await sink.received()).length).toBe(2);
});

test("an unload send survives an immediate navigation by keepalive", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await open(page);
  const body = JSON.stringify({ resourceSpans: [], pad: "u".repeat(2000) });
  await drive(
    page,
    (t, a) => {
      t.create("t", { endpoint: a.endpoint });
      void t.send("t", a.body, "unload");
      location.href = "/health";
    },
    { endpoint: sink.endpoint, body },
  );
  await page.waitForURL("**/health");
  const [got] = await sink.waitFor((r) => r.length === 1);
  expect(got?.body).toEqual(JSON.parse(body));
  await page.goto("/page/transport-page");
  const made = await drive(page, (t) => t.made(), null);
  expect(made).toEqual([expect.objectContaining({ kind: "fetch", keepalive: true })]);
});

test("with this transport's keepalive budget in use and no headers, an unload send goes by beacon and survives navigation", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await open(page);
  // The held fetch reserves the transport's budget without touching the browser's quota, so the
  // beacon is the browser's to accept. Uncompressed, both sends reach fetch or beacon at once.
  const body = await drive(
    page,
    (t, a) => {
      t.create("t", { endpoint: a.endpoint, holdFetch: true, compression: "none" });
      const small = t.randomBody(20_000);
      void t.send("t", t.randomBody(60_000), "unload");
      void t.send("t", small, "unload");
      location.href = "/health";
      return small;
    },
    { endpoint: sink.endpoint },
  );
  await page.waitForURL("**/health");
  const [got] = await sink.waitFor((r) => r.length === 1);
  expect(got?.encoding).toBeNull();
  expect(got?.contentType).toMatch(/^application\/json/);
  expect(got?.body).toEqual(JSON.parse(body));
  await page.goto("/page/transport-page");
  const made = await drive(page, (t) => t.made(), null);
  expect(made.map((m) => [m.kind, m.keepalive, m.accepted])).toEqual([
    ["fetch", true, undefined],
    ["beacon", false, true],
  ]);
});

test("Chromium counts beacons against the keepalive quota, so a refused beacon is a retry", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await open(page);
  const results = await drive(
    page,
    (t, a) => {
      t.create("t", { endpoint: a.endpoint, compression: "none" });
      return Promise.all([
        t.send("t", t.randomBody(60_000), "unload"),
        t.send("t", t.randomBody(20_000), "unload"),
      ]);
    },
    { endpoint: sink.endpoint },
  );
  expect(results).toEqual([{ kind: "ok" }, { kind: "retry", reason: "beacon refused" }]);
  const made = await drive(page, (t) => t.made(), null);
  expect(made.map((m) => [m.kind, m.accepted])).toEqual([
    ["fetch", undefined],
    ["beacon", false],
  ]);
  expect((await sink.waitFor((r) => r.length === 1)).length).toBe(1);
});

test("offline queues without a request, and going online drains", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await open(page);
  await drive(
    page,
    (t, a) => {
      t.create("t", { endpoint: a.endpoint });
      t.createDelivery("t");
    },
    { endpoint: sink.endpoint },
  );
  await context.setOffline(true);
  const direct = await drive(page, (t, a) => t.send("t", a, "normal"), JSON.stringify(EMPTY));
  expect(direct).toEqual({ kind: "retry", reason: "offline" });
  expect(await drive(page, (t, a) => t.deliver("t", a), JSON.stringify(EMPTY))).toBe("queued");
  expect(await drive(page, (t) => t.queued("t"), null)).toBe(1);
  expect(await drive(page, (t) => t.made().length, null)).toBe(0);
  await context.setOffline(false);
  const [got] = await sink.waitFor((r) => r.length === 1);
  expect(got?.body).toEqual(EMPTY);
  await expect.poll(() => drive(page, (t) => t.queued("t"), null)).toBe(0);
});
