import type { RumRuntime, RumTelemetry } from "@libo11y/rum";
import { expect, type Page, test } from "@playwright/test";
import { createSink } from "../../web/browser/harness/sink.ts";
import { type FixtureOptions, logRecords, rerunRum, type SinkSpan, spans, startRum } from "./harness/page.ts";

/** What the app fixture leaves on window. */
type FixtureWindow = { __rum: { telemetry: RumTelemetry; runtime: RumRuntime } };

const ALL = ["views", "actions", "errors"];

function forceFlush(page: Page): Promise<unknown> {
  return page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum.telemetry.forceFlush());
}

function start(page: Page, endpoint: string, opts: Partial<FixtureOptions> = {}): Promise<void> {
  return startRum(page, "app", { endpoint, collectors: ALL, ...opts });
}

const isAction = (s: SinkSpan): boolean => s.name === "action click";

test("a soft navigation is a root view span linked to the click that caused it", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await start(page, sink.endpoint);
  await page.click('[data-o11y="Open doc"]');
  await expect(page.locator("h1")).toHaveText("Doc");
  await page.waitForTimeout(300);
  await forceFlush(page);
  const got = await sink.waitFor((r) => spans(r).some((s) => s.name === "view /page/rum-app/docs/$id"));
  const view = spans(got).find((s) => s.name === "view /page/rum-app/docs/$id");
  const click = spans(got).find((s) => isAction(s) && s.attributes["o11y.rum.action.name"] === "Open doc");
  expect(view?.attributes["o11y.rum.view.kind"]).toBe("soft");
  expect(view?.attributes["o11y.rum.span.shape"]).toBe("view");
  expect(view?.parentSpanId).toBeUndefined();
  expect(view?.links.map((l) => l.spanId)).toEqual([click?.spanId]);
  expect((view?.end ?? 0) - (view?.start ?? 0)).toBeLessThan(5000);
  await page.goto("about:blank");
  const after = await sink.waitFor(
    (r) => logRecords(r).filter((l) => l.eventName === "o11y.rum.view.summary").length >= 2,
  );
  const names = logRecords(after)
    .filter((l) => l.eventName === "o11y.rum.view.summary")
    .map((l) => l.attributes["o11y.rum.view.name"]);
  expect(names).toContain("/page/rum-app");
  expect(names).toContain("/page/rum-app/docs/$id");
});

test("the initial view span is a child of app_load", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await start(page, sink.endpoint);
  await page.waitForFunction(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav !== undefined && nav.loadEventEnd > 0;
  });
  await page.waitForTimeout(1500);
  await forceFlush(page);
  const got = await sink.waitFor((r) => spans(r).some((s) => s.name === "view /page/rum-app"));
  const view = spans(got).find((s) => s.name === "view /page/rum-app");
  const load = spans(got).find((s) => s.name === "app_load");
  expect(view?.attributes["o11y.rum.view.kind"]).toBe("initial");
  expect(view?.parentSpanId).toBe(load?.spanId);
});

test("a click's request is its child and the action ends after the request", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await start(page, sink.endpoint);
  await page.click('[data-o11y="Load"]');
  await expect(page.locator("#out p")).toHaveText("loaded");
  await page.waitForTimeout(300);
  await forceFlush(page);
  const got = await sink.waitFor((r) =>
    spans(r).some((s) => isAction(s) && s.attributes["o11y.rum.action.name"] === "Load"),
  );
  const action = spans(got).find((s) => isAction(s) && s.attributes["o11y.rum.action.name"] === "Load");
  const fetchSpan = spans(got).find((s) => String(s.attributes["url.full"] ?? "").endsWith("/echo"));
  expect(action?.attributes["o11y.rum.span.shape"]).toBe("action");
  expect(action?.attributes["o11y.rum.element.selector"]).toBe('[data-o11y="Load"]');
  expect(fetchSpan?.parentSpanId).toBe(action?.spanId);
  expect(fetchSpan?.traceId).toBe(action?.traceId);
  expect(action?.end ?? 0).toBeGreaterThanOrEqual(fetchSpan?.end ?? Number.POSITIVE_INFINITY);
  expect((action?.end ?? 0) - (action?.start ?? 0)).toBeLessThan(1000);
});

test("rapid clicks on a dead button are rage and dead clicks", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await start(page, sink.endpoint);
  for (let i = 0; i < 3; i++) await page.click("#nothing", { delay: 0 });
  await page.waitForTimeout(1300);
  await forceFlush(page);
  const got = await sink.waitFor((r) =>
    logRecords(r).some((l) => l.attributes["o11y.rum.frustration.type"] === "dead"),
  );
  const frustrations = logRecords(got).filter((l) => l.eventName === "o11y.rum.frustration");
  const rage = frustrations.filter((l) => l.attributes["o11y.rum.frustration.type"] === "rage");
  expect(rage.length).toBe(1);
  expect(rage[0]?.attributes["o11y.rum.element.selector"]).toBe("#nothing");
  await page.goto("about:blank");
  const after = await sink.waitFor((r) =>
    logRecords(r).some(
      (l) =>
        l.eventName === "o11y.rum.view.summary" && l.attributes["o11y.rum.summary.frustrations.rage"] === 1,
    ),
  );
  expect(after.length).toBeGreaterThan(0);
});

test("an error click retains an unkept session and carries the breadcrumbs", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await start(page, sink.endpoint, { sessionSampleRate: 0 });
  await page.click('[data-o11y="Load"]');
  await expect(page.locator("#out p")).toHaveText("loaded");
  await page.click('[data-o11y="Throw"]');
  await page.waitForTimeout(300);
  await forceFlush(page);
  const got = await sink.waitFor(
    (r) =>
      logRecords(r).some((l) => l.eventName === "o11y.rum.error") &&
      logRecords(r).some((l) => l.attributes["o11y.rum.frustration.type"] === "error") &&
      spans(r).some((s) => s.name === "app_load"),
  );
  const err = logRecords(got).find((l) => l.eventName === "o11y.rum.error");
  expect(err?.attributes["o11y.rum.error.source"]).toBe("uncaught");
  expect(err?.attributes["exception.type"]).toBe("Error");
  expect(err?.attributes["exception.message"]).toBe("boom");
  const crumbs = String(err?.attributes["o11y.rum.error.breadcrumbs"]).split("\n");
  expect(crumbs.some((c) => /^click Load -\d+ms$/.test(c))).toBe(true);
  expect(crumbs.some((c) => /^fetch GET 127\.0\.0\.1 200 -\d+ms$/.test(c))).toBe(true);
  expect(crumbs.at(-1)).toMatch(/^click Throw -\d+ms$/);
  expect(crumbs.join("\n")).not.toContain("/echo");
});

test("rejections, broken resources and CSP violations are errors of their sources", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await page.goto("/page/rum-app?csp=1");
  await rerunRum(page, { endpoint: sink.endpoint, collectors: ALL });
  await page.click('[data-o11y="Reject"]');
  await page.click('[data-o11y="Broken"]');
  await page.click('[data-o11y="Bad image"]');
  await page.waitForTimeout(500);
  await forceFlush(page);
  const got = await sink.waitFor((r) => {
    const sources = new Set(logRecords(r).map((l) => l.attributes["o11y.rum.error.source"]));
    return sources.has("unhandled_rejection") && sources.has("resource") && sources.has("csp");
  });
  const errs = logRecords(got).filter((l) => l.eventName === "o11y.rum.error");
  const rejection = errs.find((l) => l.attributes["o11y.rum.error.source"] === "unhandled_rejection");
  expect(rejection?.attributes["exception.message"]).toBe("nope");
  const resource = errs.find(
    (l) =>
      l.attributes["o11y.rum.error.source"] === "resource" &&
      String(l.attributes["exception.message"]).includes("missing.png"),
  );
  expect(resource?.attributes["exception.message"]).toMatch(
    /^img failed to load: http:\/\/127\.0\.0\.1:\d+\/missing\.png$/,
  );
  const csp = errs.find((l) => l.attributes["o11y.rum.error.source"] === "csp");
  expect(csp?.attributes["exception.type"]).toBe("CSPViolation");
  expect(csp?.attributes["exception.message"]).toMatch(/^img-src blocked http:\/\/localhost:\d+$/);
  expect(JSON.stringify(errs)).not.toContain("secret");
});

test("console.error is captured when asked", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await start(page, sink.endpoint, { collectors: [...ALL, "console"] });
  await page.evaluate(() => console.error("bad", 2));
  await forceFlush(page);
  const got = await sink.waitFor((r) =>
    logRecords(r).some((l) => l.attributes["o11y.rum.error.source"] === "console"),
  );
  const err = logRecords(got).find((l) => l.attributes["o11y.rum.error.source"] === "console");
  expect(err?.attributes["exception.message"]).toBe("bad 2");
});

test("while consent is pending, clicks, navigations and errors send nothing", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await start(page, sink.endpoint, { consent: "pending" });
  for (const label of ["Load", "Open doc", "Throw", "Reject", "Broken"]) {
    await page.click(`[data-o11y="${label}"]`);
  }
  await page.click("#nothing");
  await page.waitForTimeout(1200);
  await forceFlush(page);
  await page.goto("about:blank");
  await page.waitForTimeout(300);
  expect(await sink.received()).toEqual([]);
});

test("a request URL keeps only allowed query parameters", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await start(page, sink.endpoint, { queryAllowList: ["page"] });
  await page.click('[data-o11y="Fetch page"]');
  await page.waitForTimeout(300);
  await forceFlush(page);
  const got = await sink.waitFor((r) =>
    spans(r).some((s) => String(s.attributes["url.full"] ?? "").includes("/echo?")),
  );
  const s = spans(got).find((x) => String(x.attributes["url.full"] ?? "").includes("/echo?"));
  expect(String(s?.attributes["url.full"])).toMatch(/\/echo\?page=2$/);
});
