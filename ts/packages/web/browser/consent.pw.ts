/**
 * WP3. The consent gate end to end in Chromium: pending sends nothing, grant sends, revoke stops
 * recording at once and clears an offline backlog so nothing is left to send. Needs WP1
 * (transport), WP2 (queue, consent and the core gate) and WP4 (the instrumentation setup installs).
 */
import { expect, type Page, test } from "@playwright/test";
import type { WebPage } from "./fixtures/setup-page.ts";
import { createSink, type SinkRequest } from "./harness/sink.ts";

// The helpers are repeated from setup.pw.ts: a module under fixtures/ is bundled for the browser,
// and a spec cannot import another spec.
type Json = Record<string, unknown>;

/** Opens /page/setup-page with query and waits for setup, failing on any page or setup error. */
export async function openSetupPage(page: Page, query: Record<string, string>): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`/page/setup-page?${new URLSearchParams(query)}`);
  await page.waitForFunction(
    () =>
      (globalThis as { __web?: unknown }).__web !== undefined ||
      ((globalThis as { __webErrors?: string[] }).__webErrors ?? []).length > 0,
  );
  expect(await page.evaluate(() => (globalThis as { __webErrors?: string[] }).__webErrors ?? [])).toEqual([]);
  expect(errors).toEqual([]);
}

/**
 * Runs fn in the page with its WebPage. fn is sent as source, so it must not close over anything
 * from the spec.
 */
export function drive<T>(page: Page, fn: (web: WebPage) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(globalThis.__web)`) as Promise<T>;
}

function items(requests: readonly SinkRequest[], signal: SinkRequest["signal"], path: string[]): Json[] {
  let level: Json[] = requests.filter((r) => r.signal === signal).map((r) => r.body as Json);
  for (const key of path) level = level.flatMap((x) => (x[key] as Json[] | undefined) ?? []);
  return level;
}

/** The names of every span the sink received. */
export function spanNames(requests: readonly SinkRequest[]): string[] {
  return items(requests, "traces", ["resourceSpans", "scopeSpans", "spans"]).map((s) => String(s.name));
}

/** The names of every metric the sink received. */
export function metricNames(requests: readonly SinkRequest[]): string[] {
  return items(requests, "metrics", ["resourceMetrics", "scopeMetrics", "metrics"]).map((m) =>
    String(m.name),
  );
}

/** Every log record the sink received. */
export function logRecords(requests: readonly SinkRequest[]): Json[] {
  return items(requests, "logs", ["resourceLogs", "scopeLogs", "logRecords"]);
}

/** The resource attributes of one request, by key. */
export function resourceAttributes(req: SinkRequest): Map<string, Json> {
  // A replay upload carries no OTLP resource.
  if (req.signal === "replay") return new Map();
  const key = { traces: "resourceSpans", metrics: "resourceMetrics", logs: "resourceLogs" }[req.signal];
  const first = ((req.body as Json)[key] as Json[] | undefined)?.[0];
  const attrs = ((first?.resource as Json | undefined)?.attributes ?? []) as { key: string; value: Json }[];
  return new Map(attrs.map((a) => [a.key, a.value]));
}

/** Long enough for a stray send (batch delay, retry, drain) to have reached the sink. */
const SETTLE_MILLIS = 2500;

test("pending sends nothing after a flush and a hide", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await openSetupPage(page, { endpoint: sink.endpoint });
  expect(await drive(page, (web) => web.state())).toBe("pending");
  await drive(page, async (web) => {
    web.emit("pending");
    await web.flush();
    web.hide();
  });
  await page.waitForTimeout(SETTLE_MILLIS);
  expect(await sink.received()).toEqual([]);
});

test("grant sends only what is recorded after it, with the deferred canary once", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await openSetupPage(page, { endpoint: sink.endpoint });
  const granted = await drive(page, async (web) => {
    web.emit("before");
    await web.flush();
    const state = web.grant();
    web.emit("after");
    await web.flush();
    return state;
  });
  expect(granted).toBe("granted");
  const got = await sink.waitFor((r) => spanNames(r).includes("after"));
  expect(spanNames(got)).not.toContain("before");
  const canaries = logRecords(got).filter((rec) => JSON.stringify(rec).includes("o11y.telemetry.configured"));
  expect(canaries).toHaveLength(1);
});

test("revoke stops recording at once", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await openSetupPage(page, { endpoint: sink.endpoint, consent: "granted" });
  const state = await drive(page, async (web) => {
    web.emit("kept");
    await web.flush();
    const after = await web.revoke();
    web.emit("revoked");
    await web.flush();
    web.hide();
    return after;
  });
  expect(state).toBe("denied");
  await sink.waitFor((r) => spanNames(r).includes("kept"));
  await page.waitForTimeout(SETTLE_MILLIS);
  expect(spanNames(await sink.received())).not.toContain("revoked");
});

test("revoke with an offline backlog leaves nothing to send when back online", async ({
  context,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  const page = await context.newPage();
  await openSetupPage(page, { endpoint: sink.endpoint, consent: "granted" });
  // The browser offline: the delivery queues in IndexedDB without an attempt.
  await context.setOffline(true);
  const state = await drive(page, async (web) => {
    web.emit("backlog");
    await web.flush();
    return web.revoke();
  });
  expect(state).toBe("denied");

  // Back online (the online event drains), granted again (the gate opening drains), and a next
  // page of the origin (setup drains): none of them finds anything left to send.
  await context.setOffline(false);
  await drive(page, (web) => {
    web.grant();
  });
  const next = await context.newPage();
  await openSetupPage(next, { endpoint: sink.endpoint, consent: "granted" });
  await next.waitForTimeout(SETTLE_MILLIS);
  expect(spanNames(await sink.received())).not.toContain("backlog");
});
