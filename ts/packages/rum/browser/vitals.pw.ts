import { expect, type Page, test } from "@playwright/test";
import { createSink } from "../../web/browser/harness/sink.ts";
import { logRecords, type SinkLog, startRum } from "./harness/page.ts";

/** Which vitals this engine can measure, as web-vitals detects them. */
interface Support {
  readonly lcp: boolean;
  readonly inp: boolean;
  readonly cls: boolean;
  readonly fcp: boolean;
  /**
   * web-vitals reports TTFB only from a navigation entry with a responseStart above zero. Firefox
   * at times reports zero, and then the page load has no TTFB.
   */
  readonly ttfb: boolean;
}

/** What this page load can measure. Call it once the load event has ended. */
function support(page: Page): Promise<Support> {
  return page.evaluate(() => {
    const types = PerformanceObserver.supportedEntryTypes ?? [];
    const timing = (globalThis as { PerformanceEventTiming?: { prototype: object } }).PerformanceEventTiming;
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return {
      lcp: types.includes("largest-contentful-paint"),
      inp: types.includes("event") && timing !== undefined && "interactionId" in timing.prototype,
      cls: types.includes("layout-shift"),
      fcp: types.includes("paint"),
      ttfb: nav !== undefined && nav.responseStart > 0,
    };
  });
}

function loaded(page: Page): Promise<unknown> {
  return page.waitForFunction(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav !== undefined && nav.loadEventEnd > 0;
  });
}

const summaries = (logs: SinkLog[]): SinkLog[] => logs.filter((l) => l.eventName === "o11y.rum.view.summary");
const vitalEvents = (logs: SinkLog[]): SinkLog[] => logs.filter((l) => l.eventName === "browser.web_vital");

test("the first summary after hide carries the vitals this engine measures, and detail events carry attribution", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await startRum(page, "perf", { endpoint: sink.endpoint, collectors: ["vitals", "actions"] });
  await loaded(page);
  const has = await support(page);
  await page.click('[data-o11y="Slow"]');
  await expect(page.locator('[data-o11y="Slow"]')).toHaveText("Done");
  // web-vitals processes interactions in an idle callback. Headless Chromium runs no idle
  // callback after a click until the next input, so the test moves the mouse.
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
  // Navigating away fires pagehide before visibilitychange, and Firefox and WebKit fire it while the
  // document still reports visible: the summary RUM emits at pagehide must already hold the latest
  // values, and web's flush must export it in unload mode.
  await page.goto("about:blank");
  const got = await sink.waitFor(
    (r) =>
      summaries(logRecords(r)).length >= 1 &&
      (!has.ttfb ||
        vitalEvents(logRecords(r)).some((e) => (e.body as { name?: string } | undefined)?.name === "ttfb")),
  );
  const first = summaries(logRecords(got)).find((s) => s.attributes["o11y.rum.summary.seq"] === 0);
  const a = first?.attributes ?? {};
  expect(a["o11y.rum.view.kind"]).toBe("initial");
  if (has.ttfb) expect(a["o11y.rum.summary.ttfb.value"]).toBeGreaterThanOrEqual(0);
  else expect(a["o11y.rum.summary.ttfb.value"]).toBeUndefined();
  if (has.fcp) expect(a["o11y.rum.summary.fcp.value"]).toBeGreaterThan(0);
  else expect(a["o11y.rum.summary.fcp.value"]).toBeUndefined();
  if (has.lcp) expect(a["o11y.rum.summary.lcp.value"]).toBeGreaterThan(0);
  else expect(a["o11y.rum.summary.lcp.value"]).toBeUndefined();
  if (has.inp) expect(a["o11y.rum.summary.inp.value"]).toBeGreaterThanOrEqual(0.2);
  else expect(a["o11y.rum.summary.inp.value"]).toBeUndefined();
  if (has.cls) expect(a["o11y.rum.summary.cls.value"]).toBeGreaterThanOrEqual(0);
  else expect(a["o11y.rum.summary.cls.value"]).toBeUndefined();
  expect(Object.keys(a).some((k) => k.includes("rating"))).toBe(false);

  const events = vitalEvents(logRecords(got));
  for (const e of events) {
    expect(e.attributes["o11y.rum.view.id"]).toBe(a["o11y.rum.view.id"]);
    expect(e.attributes["session.id"]).toBe(a["session.id"]);
    expect(Object.keys(e.attributes).some((k) => k.includes("rating"))).toBe(false);
  }
  const byName = (n: string): SinkLog | undefined =>
    events.find((e) => (e.body as { name?: string } | undefined)?.name === n);
  if (has.ttfb) expect(byName("ttfb")?.body).toMatchObject({ name: "ttfb", id: expect.any(String) });
  else expect(byName("ttfb")).toBeUndefined();
  if (has.lcp) {
    const lcp = byName("lcp");
    expect((lcp?.body as { value?: number } | undefined)?.value).toBe(a["o11y.rum.summary.lcp.value"]);
    expect(lcp?.attributes["o11y.rum.element.selector"]).toBe("#hero");
    expect(lcp?.attributes["o11y.rum.vital.attribution.time_to_first_byte"]).toBeGreaterThanOrEqual(0);
  } else expect(byName("lcp")).toBeUndefined();
  if (has.inp) {
    const inp = byName("inp");
    expect(inp?.attributes["o11y.rum.element.selector"]).toBe('[data-o11y="Slow"]');
    expect(inp?.attributes["o11y.rum.vital.attribution.interaction_type"]).toBe("pointer");
    expect(inp?.attributes["o11y.rum.vital.attribution.processing_duration"]).toBeGreaterThanOrEqual(0.2);
  } else expect(byName("inp")).toBeUndefined();
});

test("an unkept session sends vitals in the summary but no browser.web_vital detail", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await startRum(page, "perf", { endpoint: sink.endpoint, collectors: ["vitals"], sessionSampleRate: 0 });
  await loaded(page);
  const has = await support(page);
  await page.waitForTimeout(200);
  await page.goto("about:blank");
  const got = await sink.waitFor((r) => summaries(logRecords(r)).length >= 1);
  const ttfb = summaries(logRecords(got))[0]?.attributes["o11y.rum.summary.ttfb.value"];
  if (has.ttfb) expect(ttfb).toBeGreaterThanOrEqual(0);
  else expect(ttfb).toBeUndefined();
  expect(vitalEvents(logRecords(got))).toEqual([]);
});
