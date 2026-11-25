/**
 * WP3. setup in Chromium against the fixture server's sink: every signal arrives with the browser
 * resource, a hide flushes by keepalive, leaving the page flushes, and an offline backlog is sent
 * by the next page of the origin. Needs WP1 (transport), WP2 (queue, consent) and WP4 (fetch and
 * XHR instrumentation, which setup installs).
 */
import { expect, type Page, test } from "@playwright/test";
import type { WebPage } from "./fixtures/setup-page.ts";
import type { RecordedSend } from "./fixtures/setup-spy.ts";
import { createSink, type SinkRequest } from "./harness/sink.ts";

// The helpers are repeated in consent.pw.ts: a module under fixtures/ is bundled for the browser,
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
  const key = { traces: "resourceSpans", metrics: "resourceMetrics", logs: "resourceLogs" }[req.signal];
  const first = ((req.body as Json)[key] as Json[] | undefined)?.[0];
  const attrs = ((first?.resource as Json | undefined)?.attributes ?? []) as { key: string; value: Json }[];
  return new Map(attrs.map((a) => [a.key, a.value]));
}

test("spans, logs and metrics reach the sink with browser.* and no user_agent.original", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await openSetupPage(page, { endpoint: sink.endpoint, consent: "granted" });
  const flushed = await drive(page, async (web) => {
    web.emit("basic");
    return web.flush();
  });
  expect(flushed).toBe(true);
  const got = await sink.waitFor(
    (r) =>
      spanNames(r).includes("basic") &&
      metricNames(r).includes("web.test.basic") &&
      JSON.stringify(logRecords(r)).includes("log basic"),
  );
  const hasUserAgentData = await drive(page, (web) => web.hasUserAgentData);
  for (const signal of ["traces", "metrics", "logs"] as const) {
    const req = got.find((r) => r.signal === signal);
    expect(req, signal).toBeDefined();
    if (req === undefined) continue;
    expect(req.contentType).toContain("application/json");
    const attrs = resourceAttributes(req);
    expect(attrs.get("service.name"), signal).toEqual({ stringValue: "web-fixture" });
    expect(attrs.has("telemetry.sdk.language"), signal).toBe(true);
    expect(attrs.has("browser.language"), signal).toBe(true);
    if (hasUserAgentData) {
      expect(attrs.has("browser.brands"), signal).toBe(true);
      expect(attrs.has("browser.platform"), signal).toBe(true);
      expect(attrs.has("browser.mobile"), signal).toBe(true);
    }
    expect(attrs.has("user_agent.original"), signal).toBe(false);
  }
});

test("userAgent: true records user_agent.original", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await openSetupPage(page, { endpoint: sink.endpoint, consent: "granted", userAgent: "1" });
  await drive(page, async (web) => {
    web.emit("ua");
    await web.flush();
  });
  const got = await sink.waitFor((r) => spanNames(r).includes("ua"));
  const ua = await page.evaluate(() => navigator.userAgent);
  const req = got.find((r) => r.signal === "traces");
  expect(req && resourceAttributes(req).get("user_agent.original")).toEqual({ stringValue: ua });
});

test("a hide flushes by keepalive", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await openSetupPage(page, { endpoint: sink.endpoint, consent: "granted" });
  await drive(page, (web) => {
    web.emit("hidden");
    web.hide();
  });
  await sink.waitFor((r) => spanNames(r).includes("hidden"));
  const sends = await page.evaluate(() => (globalThis as { __sends?: RecordedSend[] }).__sends ?? []);
  const traces = sends.filter((s) => s.url === `${sink.endpoint}/v1/traces`);
  expect(traces.length).toBeGreaterThan(0);
  expect(traces.every((s) => s.via === "keepalive" || s.via === "beacon")).toBe(true);
  expect(traces.some((s) => s.via === "keepalive")).toBe(true);
});

test("leaving the page flushes what it recorded", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await openSetupPage(page, { endpoint: sink.endpoint, consent: "granted" });
  await drive(page, (web) => web.emit("leaving"));
  await page.goto("/health");
  const got = await sink.waitFor(
    (r) => spanNames(r).includes("leaving") && JSON.stringify(logRecords(r)).includes("log leaving"),
  );
  expect(spanNames(got).filter((n) => n === "leaving")).toHaveLength(1);
});

test("an offline backlog from one page is sent by the next page of the origin", async ({
  context,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  const first = await context.newPage();
  await openSetupPage(first, { endpoint: sink.endpoint, consent: "granted" });
  // The browser offline: the delivery queues in IndexedDB without an attempt.
  await context.setOffline(true);
  const flushed = await drive(first, async (web) => {
    web.emit("carried");
    return web.flush();
  });
  expect(flushed).toBe(true);
  await first.close();
  await context.setOffline(false);
  expect(spanNames(await sink.received())).not.toContain("carried");

  const second = await context.newPage();
  await openSetupPage(second, { endpoint: sink.endpoint, consent: "granted" });
  const got = await sink.waitFor((r) => spanNames(r).includes("carried"), 15_000);
  expect(spanNames(got).filter((n) => n === "carried")).toHaveLength(1);
});
