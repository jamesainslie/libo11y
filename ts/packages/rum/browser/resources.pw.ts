import type { RumTelemetry } from "@libo11y/rum";
import { expect, type Page, test } from "@playwright/test";
import { createSink } from "../../web/browser/harness/sink.ts";
import { type SinkSpan, spans, startRum } from "./harness/page.ts";

type FixtureWindow = {
  __rum: { telemetry: RumTelemetry };
  __loadAssets(serverTiming?: string): void;
};

const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

function forceFlush(page: Page): Promise<unknown> {
  return page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum.telemetry.forceFlush());
}

function waitForLoad(page: Page): Promise<unknown> {
  return page.waitForFunction(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav !== undefined && nav.loadEventEnd > 0;
  });
}

const assetSpans = (all: SinkSpan[]): SinkSpan[] =>
  all.filter((s) => s.name.startsWith("resource ") && String(s.attributes["url.full"]).includes("/asset/"));

test("scripts, stylesheets and images become resource spans with Server-Timing links and events", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await startRum(page, "perf", { endpoint: sink.endpoint, collectors: ["views", "resources"] });
  await waitForLoad(page);
  const serverTiming = await page.evaluate(
    () => globalThis.isSecureContext && "serverTiming" in PerformanceResourceTiming.prototype,
  );
  await page.waitForTimeout(1200);
  await page.evaluate((tp) => (globalThis as unknown as FixtureWindow).__loadAssets(tp), TRACEPARENT);
  await page.waitForFunction(() => {
    const img = document.querySelector("img");
    return img?.complete === true && "__assetLoaded" in globalThis;
  });
  await page.waitForTimeout(300);
  await forceFlush(page);
  const got = await sink.waitFor((r) => assetSpans(spans(r)).length >= 3);
  const all = spans(got);
  const assets = assetSpans(all);
  expect(assets.map((s) => s.attributes["o11y.rum.resource.type"]).sort()).toEqual([
    "image",
    "script",
    "stylesheet",
  ]);
  for (const s of assets) {
    expect(s.name).toBe(`resource ${String(s.attributes["o11y.rum.resource.type"])}`);
    expect(String(s.attributes["url.full"])).not.toContain("?");
    expect(s.attributes["server.address"]).toBe("127.0.0.1");
    expect(s.attributes["session.id"]).toEqual(expect.any(String));
    expect(s.parentSpanId).toBeUndefined();
    expect(s.end).toBeGreaterThanOrEqual(s.start);
  }
  const view = all.find((s) => s.name === "view /page/rum-perf");
  const img = assets.find((s) => s.attributes["o11y.rum.resource.type"] === "image");
  if (view !== undefined) expect(img?.links.map((l) => l.spanId)).toContain(view.spanId);
  if (serverTiming) {
    expect(img?.links.map((l) => l.spanId)).toContain("b7ad6b7169203331");
    expect(img?.events.map((e) => [e.name, e.attributes["o11y.rum.server_timing.name"]])).toEqual([
      ["server_timing", "db"],
    ]);
    expect(img?.events[0]?.attributes["o11y.rum.server_timing.duration"]).toBeCloseTo(0.012, 6);
  } else {
    expect(img?.links.map((l) => l.spanId)).not.toContain("b7ad6b7169203331");
    expect(img?.events).toEqual([]);
  }
  // The fixture bundle loaded during the page load: a child of app_load.
  const load = all.find((s) => s.name === "app_load");
  const bundle = all.find(
    (s) => s.name === "resource script" && String(s.attributes["url.full"]).includes("/bundles/rum-perf.js"),
  );
  expect(bundle?.parentSpanId).toBe(load?.spanId);
  // RUM's own OTLP posts are never resources.
  expect(
    all.some((s) => s.name.startsWith("resource ") && String(s.attributes["url.full"]).includes("/sink/")),
  ).toBe(false);
});
