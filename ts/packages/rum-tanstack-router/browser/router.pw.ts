import type { RumTelemetry } from "@libo11y/rum";
import { expect, type Page, test } from "@playwright/test";
import { logRecords, type SinkSpan, spans, startRum } from "../../rum/browser/harness/page.ts";
import { createSink } from "../../web/browser/harness/sink.ts";

type FixtureWindow = { __rum: { telemetry: RumTelemetry }; __renderedAt?: number };

/** The fixture's document loader delay. */
const LOADER_MILLIS = 150;

function forceFlush(page: Page): Promise<unknown> {
  return page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum.telemetry.forceFlush());
}

const named =
  (name: string) =>
  (s: SinkSpan): boolean =>
    s.name === name;

test("a link click starts a soft view named by route template that ends after the route rendered", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await startRum(page, "tanstack-router-router", { endpoint: sink.endpoint });
  await page.click('[data-o11y="Open doc"]');
  await expect(page.locator("h1")).toHaveText("Doc 42");
  await page.waitForTimeout(300);
  const renderedAt = await page.evaluate(() => (globalThis as unknown as FixtureWindow).__renderedAt ?? 0);
  await forceFlush(page);
  const got = await sink.waitFor((r) => spans(r).some(named("view /documents/$docId")));
  const view = spans(got).find(named("view /documents/$docId"));
  const click = spans(got).find(
    (s) => s.name === "action click" && s.attributes["o11y.rum.action.name"] === "Open doc",
  );
  expect(view?.attributes["o11y.rum.view.kind"]).toBe("soft");
  expect(view?.attributes["o11y.rum.view.name"]).toBe("/documents/$docId");
  expect(view?.parentSpanId).toBeUndefined();
  expect(click).toBeDefined();
  expect(view?.links.map((l) => l.spanId)).toEqual([click?.spanId]);
  // The view covers the loader and ends at a paint after the route component committed.
  expect((view?.end ?? 0) - (view?.start ?? 0)).toBeGreaterThanOrEqual(LOADER_MILLIS - 5);
  expect(view?.end ?? 0).toBeGreaterThanOrEqual(renderedAt - 1);
  expect((view?.end ?? 0) - renderedAt).toBeLessThan(1000);
  // No view is named after the raw URL.
  expect(spans(got).filter((s) => s.name.startsWith("view ") && s.name.includes("42"))).toEqual([]);
});

test("the initial view is named by its route template once the router resolved", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await startRum(page, "tanstack-router-router", { endpoint: sink.endpoint });
  await expect(page.locator('[data-o11y="Open doc"]')).toBeVisible();
  await page.waitForTimeout(300);
  await forceFlush(page);
  const got = await sink.waitFor((r) => spans(r).some(named("view /")));
  const view = spans(got).find(named("view /"));
  expect(view?.attributes["o11y.rum.view.kind"]).toBe("initial");
  expect((view?.end ?? 0) - (view?.start ?? 0)).toBeLessThan(5000);
  await page.goto("about:blank");
  const after = await sink.waitFor((r) => logRecords(r).some((l) => l.eventName === "o11y.rum.view.summary"));
  const names = logRecords(after)
    .filter((l) => l.eventName === "o11y.rum.view.summary")
    .map((l) => l.attributes["o11y.rum.view.name"]);
  expect(names).toEqual(["/"]);
});

test("consent granted after the router rendered names the view and ends its span, not at the cap", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await startRum(page, "tanstack-router-router", { endpoint: sink.endpoint, consent: "pending" });
  await page.click('[data-o11y="Open doc"]');
  await expect(page.locator("h1")).toHaveText("Doc 42");
  await page.waitForTimeout(300);
  const renderedAt = await page.evaluate(() => (globalThis as unknown as FixtureWindow).__renderedAt ?? 0);
  const grantedAt = await page.evaluate(() => {
    (globalThis as unknown as FixtureWindow).__rum.telemetry.consent.grant();
    return Date.now();
  });
  await page.waitForFunction(() => (globalThis as unknown as FixtureWindow).__rum.telemetry.rum.sessionId());
  await page.waitForTimeout(300);
  await forceFlush(page);
  // Well inside the 10 s view span cap.
  const got = await sink.waitFor((r) => spans(r).some(named("view /documents/$docId")), 3000);
  const view = spans(got).find(named("view /documents/$docId"));
  expect(view?.attributes["o11y.rum.view.kind"]).toBe("initial");
  expect(view?.end ?? 0).toBeLessThanOrEqual(grantedAt);
  expect(Math.abs((view?.end ?? 0) - renderedAt)).toBeLessThan(1000);
});
