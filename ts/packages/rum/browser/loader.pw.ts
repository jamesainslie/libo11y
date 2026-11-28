import type { RumTelemetry } from "@libo11y/rum";
import { expect, type Page, test } from "@playwright/test";
import { createSink } from "../../web/browser/harness/sink.ts";
import { logRecords, spans } from "./harness/page.ts";

type FixtureWindow = { __rum?: { telemetry: RumTelemetry } };

async function open(page: Page, consent: string, endpoint: string): Promise<void> {
  const q = new URLSearchParams({ consent, endpoint });
  await page.goto(`/page/rum-loader?${q.toString()}`, { waitUntil: "commit" });
  await page.click('[data-o11y="Early"]');
  await page.waitForFunction(() => (globalThis as unknown as FixtureWindow).__rum !== undefined, null, {
    timeout: 10_000,
  });
}

/** Epoch milliseconds of the load event's start. */
function loadEventStart(page: Page): Promise<number> {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    return performance.timeOrigin + nav.loadEventStart;
  });
}

test("a granted bootstrap hands the early error and click to RUM loaded after the load event", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await open(page, "granted", sink.endpoint);
  await page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum?.telemetry.forceFlush());
  const got = await sink.waitFor(
    (r) =>
      logRecords(r).some((l) => l.eventName === "o11y.rum.error") &&
      spans(r).some((s) => s.name === "action click"),
  );
  const error = logRecords(got).find((l) => l.eventName === "o11y.rum.error");
  expect(error?.attributes["o11y.rum.error.source"]).toBe("uncaught");
  expect(error?.attributes["exception.message"]).toBe("early boom");
  const click = spans(got).find((s) => s.name === "action click");
  expect(click?.attributes["o11y.rum.action.name"]).toBe("Early");
  expect(click?.start ?? Number.POSITIVE_INFINITY).toBeLessThan(await loadEventStart(page));
});

test("a pending bootstrap records nothing early, even once consent is granted", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await open(page, "pending", sink.endpoint);
  await page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum?.telemetry.consent.grant());
  await page.waitForFunction(() => (globalThis as unknown as FixtureWindow).__rum?.telemetry.rum.sessionId());
  await page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum?.telemetry.forceFlush());
  await page.waitForTimeout(500);
  const got = await sink.received();
  expect(logRecords(got).filter((l) => l.eventName === "o11y.rum.error")).toEqual([]);
  expect(spans(got).filter((s) => s.name === "action click")).toEqual([]);
});
