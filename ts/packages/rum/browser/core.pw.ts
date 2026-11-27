import type { RumRuntime, RumTelemetry } from "@libo11y/rum";
import { expect, type Page, test } from "@playwright/test";
import { createSink } from "../../web/browser/harness/sink.ts";
import { logRecords, rerunRum, spans, startRum } from "./harness/page.ts";

/** What the core fixture leaves on window. */
type FixtureWindow = { __rum: { telemetry: RumTelemetry; runtime: RumRuntime } };

const RETENTION_DB = "libo11y-rum-retention";

function sessionId(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum.telemetry.rum.sessionId());
}

function forceFlush(page: Page): Promise<unknown> {
  return page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum.telemetry.forceFlush());
}

/** The entries in the retention database, or -1 when it has no batch store. */
function retentionEntries(page: Page): Promise<number> {
  return page.evaluate(async (name) => {
    const req = indexedDB.open(name);
    const db: IDBDatabase = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    try {
      if (!db.objectStoreNames.contains("otlp-batches")) return -1;
      return await new Promise<number>((res, rej) => {
        const c = db.transaction("otlp-batches").objectStore("otlp-batches").count();
        c.onsuccess = () => res(c.result);
        c.onerror = () => rej(c.error);
      });
    } finally {
      db.close();
    }
  }, RETENTION_DB);
}

/** Waits until the documentLoad span of the page was recorded, which follows the load event. */
async function loaded(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav !== undefined && nav.loadEventEnd > 0;
  });
  await page.waitForTimeout(100);
}

test("pending consent stores and sends nothing", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await startRum(page, "core", { endpoint: sink.endpoint, consent: "pending" });
  await loaded(page);
  await forceFlush(page);
  expect(await page.evaluate(() => localStorage.getItem("libo11y.rum.session"))).toBeNull();
  const dbs = await page.evaluate(async () =>
    typeof indexedDB.databases === "function" ? (await indexedDB.databases()).map((d) => d.name) : [],
  );
  expect(dbs).not.toContain(RETENTION_DB);
  expect(await sessionId(page)).toBeUndefined();
  expect(await sink.received()).toEqual([]);
});

test("an unkept session sends its summary when the page goes away, and no detail", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await startRum(page, "core", { endpoint: sink.endpoint, sessionSampleRate: 0 });
  const id = await sessionId(page);
  await loaded(page);
  await page.goto("about:blank");
  const got = await sink.waitFor((r) => logRecords(r).some((l) => l.eventName === "o11y.rum.view.summary"));
  const logs = logRecords(got);
  expect(logs.map((l) => l.eventName)).toEqual(["o11y.rum.view.summary"]);
  expect(logs[0]?.attributes["session.id"]).toBe(id);
  expect(logs[0]?.attributes["o11y.rum.view.kind"]).toBe("initial");
  expect(logs[0]?.attributes["o11y.rum.view.name"]).toBe("/page/rum-core");
  expect(spans(got)).toEqual([]);
});

test("retaining the session sends what was buffered, across a reload", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await startRum(page, "core", { endpoint: sink.endpoint, sessionSampleRate: 0 });
  const first = await sessionId(page);
  await loaded(page);
  await forceFlush(page);
  await expect.poll(() => retentionEntries(page)).toBeGreaterThan(0);
  await page.reload();
  await rerunRum(page, { endpoint: sink.endpoint, sessionSampleRate: 0 });
  expect(await sessionId(page)).toBe(first);
  await loaded(page);
  await forceFlush(page);
  expect(spans(await sink.received())).toEqual([]);
  await page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum.runtime.session.retain("error"));
  const got = await sink.waitFor((r) => spans(r).filter((s) => s.name === "app_load").length >= 2);
  const loads = spans(got).filter((s) => s.name === "app_load");
  expect(loads.every((s) => s.attributes["session.id"] === first)).toBe(true);
  expect(logRecords(got).some((l) => l.eventName === "o11y.rum.session.start")).toBe(true);
  await expect.poll(() => retentionEntries(page)).toBe(0);
});

test("two tabs share one session", async ({ context, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  const a = await context.newPage();
  const b = await context.newPage();
  await startRum(a, "core", { endpoint: sink.endpoint });
  await startRum(b, "core", { endpoint: sink.endpoint });
  const [ida, idb] = await Promise.all([sessionId(a), sessionId(b)]);
  expect(ida).toBeDefined();
  expect(idb).toBe(ida);
});

test("a kept session's app_load span has the RUM shape", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await startRum(page, "core", { endpoint: sink.endpoint });
  await loaded(page);
  await forceFlush(page);
  const got = await sink.waitFor((r) => spans(r).some((s) => s.name === "app_load"));
  const load = spans(got).find((s) => s.name === "app_load");
  expect(load?.attributes["o11y.rum.span.shape"]).toBe("app_load");
  expect(load?.attributes["o11y.rum.platform"]).toBe("web");
  expect(load?.attributes["session.id"]).toBe(await sessionId(page));
  expect(typeof load?.attributes["o11y.rum.view.id"]).toBe("string");
  expect(spans(got).some((s) => s.name === "documentLoad")).toBe(false);
});

test("revoking consent removes the session and the buffer", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await startRum(page, "core", { endpoint: sink.endpoint, sessionSampleRate: 0 });
  await loaded(page);
  await forceFlush(page);
  await expect.poll(() => retentionEntries(page)).toBeGreaterThan(0);
  await page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum.telemetry.consent.revoke());
  expect(await page.evaluate(() => localStorage.getItem("libo11y.rum.session"))).toBeNull();
  expect(await sessionId(page)).toBeUndefined();
  expect(await retentionEntries(page)).toBe(0);
});
