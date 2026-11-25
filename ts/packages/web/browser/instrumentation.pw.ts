/**
 * WP4. The fetch, XHR and document-load instrumentation in Chromium, on core telemetry with an
 * in-page exporter (fixtures/instrumentation-*.ts): same-origin requests carry traceparent,
 * cross-origin ones only with propagateTo, pending consent sends and records nothing, documentLoad
 * adopts the Server-Timing traceparent, and a grant after load records the historical times.
 */
import { expect, type Page, test } from "@playwright/test";
import type { SpanJson } from "./fixtures/instrumentation-common.ts";

interface Echo {
  readonly method: string;
  readonly headers: Record<string, string>;
}

type Kind = "fetchEcho" | "xhrEcho" | "xhrEchoSync";

interface InstApi {
  fetchEcho(url: string): Promise<Echo>;
  xhrEcho(url: string): Promise<Echo>;
  xhrEchoSync(url: string): Promise<Echo>;
  fetchFrameRequest(url: string): Promise<Echo & { body: string }>;
  fetchData(): Promise<string>;
  grant(): string;
  spans(): Promise<SpanJson[]>;
  uninstall(): { fetch: boolean; open: boolean; send: boolean };
}

interface DocLoadApi {
  done(): Promise<boolean>;
  finished(): boolean;
  grant(): number;
  loaded(): boolean;
  spans(): Promise<SpanJson[]>;
}

const CLIENT = 2;

async function openHttp(page: Page, query = ""): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`/page/instrumentation-http${query}`);
  await page.waitForFunction(() => (globalThis as { __inst?: unknown }).__inst !== undefined);
  expect(errors).toEqual([]);
}

function request(page: Page, kind: Kind, url: string): Promise<Echo> {
  return page.evaluate(([k, u]) => (globalThis as unknown as { __inst: InstApi }).__inst[k](u), [
    kind,
    url,
  ] as const);
}

function httpSpans(page: Page): Promise<SpanJson[]> {
  return page.evaluate(() => (globalThis as unknown as { __inst: InstApi }).__inst.spans());
}

function crossOrigin(baseURL: string | undefined): string {
  const url = new URL("/echo", baseURL);
  url.hostname = "localhost";
  return url.href;
}

for (const kind of ["fetchEcho", "xhrEcho", "xhrEchoSync"] as const) {
  test(`${kind}: a same-origin request carries the client span's traceparent`, async ({ page }) => {
    await openHttp(page);
    const echo = await request(page, kind, "/echo?q=1");
    const spans = (await httpSpans(page)).filter((s) => s.kind === CLIENT);
    expect(spans).toHaveLength(1);
    const [span] = spans as [SpanJson];
    expect(echo.headers.traceparent).toBe(`00-${span.traceId}-${span.spanId}-01`);
    expect(span.name).toBe("GET");
    expect(span.attributes["url.full"]).toBe(new URL("/echo?q=1", page.url()).href);
    expect(span.attributes["http.response.status_code"]).toBe(200);
    expect(span.attributes["server.address"]).toBe("127.0.0.1");
  });
}

for (const kind of ["fetchEcho", "xhrEcho"] as const) {
  test(`${kind}: a cross-origin request carries no traceparent unless propagateTo allows it`, async ({
    page,
    baseURL,
  }) => {
    const target = crossOrigin(baseURL);
    await openHttp(page);
    const plain = await request(page, kind, target);
    expect(plain.headers.traceparent).toBeUndefined();
    const spans = (await httpSpans(page)).filter((s) => s.kind === CLIENT);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes["server.address"]).toBe("localhost");

    await openHttp(page, `?propagateTo=${encodeURIComponent(new URL(target).origin)}`);
    const allowed = await request(page, kind, target);
    const [span] = (await httpSpans(page)).filter((s) => s.kind === CLIENT) as [SpanJson];
    expect(allowed.headers.traceparent).toBe(`00-${span.traceId}-${span.spanId}-01`);
  });
}

test("a Request from an iframe keeps its method, headers and body, and gets the context", async ({
  page,
}) => {
  await openHttp(page);
  const echo = await page.evaluate(() =>
    (globalThis as unknown as { __inst: InstApi }).__inst.fetchFrameRequest("/echo"),
  );
  const [span] = (await httpSpans(page)).filter((s) => s.kind === CLIENT) as [SpanJson];
  expect(echo.method).toBe("POST");
  expect(echo.headers["x-app"]).toBe("1");
  expect(echo.body).toBe("payload");
  expect(echo.headers.traceparent).toBe(`00-${span.traceId}-${span.spanId}-01`);
  expect(span.name).toBe("POST");
  expect(span.attributes["url.full"]).toBe(new URL("/echo", page.url()).href);
});

test("a data: URL fetch is passed through with no span", async ({ page }) => {
  await openHttp(page);
  const text = await page.evaluate(() => (globalThis as unknown as { __inst: InstApi }).__inst.fetchData());
  expect(text).toBe("secret payload");
  expect(await httpSpans(page)).toEqual([]);
});

test("pending consent sends no header and records no span, and a grant turns both on", async ({ page }) => {
  await openHttp(page, "?consent=pending");
  for (const kind of ["fetchEcho", "xhrEcho", "xhrEchoSync"] as const) {
    const echo = await request(page, kind, "/echo");
    expect(echo.headers.traceparent, kind).toBeUndefined();
  }
  expect(await httpSpans(page)).toEqual([]);
  await page.evaluate(() => (globalThis as unknown as { __inst: InstApi }).__inst.grant());
  const echo = await request(page, "fetchEcho", "/echo");
  expect(echo.headers.traceparent).toBeDefined();
  expect(await httpSpans(page)).toHaveLength(1);
});

test("uninstall restores fetch and XMLHttpRequest, and later requests are not instrumented", async ({
  page,
}) => {
  await openHttp(page);
  const restored = await page.evaluate(() =>
    (globalThis as unknown as { __inst: InstApi }).__inst.uninstall(),
  );
  expect(restored).toEqual({ fetch: true, open: true, send: true });
  for (const kind of ["fetchEcho", "xhrEcho"] as const) {
    const echo = await request(page, kind, "/echo");
    expect(echo.headers.traceparent, kind).toBeUndefined();
  }
  expect(await httpSpans(page)).toEqual([]);
});

async function openDocLoad(page: Page, query: string): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`/page/instrumentation-docload${query}`);
  await page.waitForFunction(() => (globalThis as { __docload?: unknown }).__docload !== undefined);
  expect(errors).toEqual([]);
}

function docLoadSpans(page: Page): Promise<SpanJson[]> {
  return page.evaluate(() => (globalThis as unknown as { __docload: DocLoadApi }).__docload.spans());
}

test("documentLoad adopts the Server-Timing traceparent as its parent", async ({ page }) => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const spanId = "00f067aa0ba902b7";
  await openDocLoad(page, `?serverTiming=00-${traceId}-${spanId}-01`);
  await page.evaluate(() => (globalThis as unknown as { __docload: DocLoadApi }).__docload.done());
  const spans = await docLoadSpans(page);
  const load = spans.find((s) => s.name === "documentLoad");
  const fetchSpan = spans.find((s) => s.name === "documentFetch");
  expect(load?.traceId).toBe(traceId);
  expect(load?.parentSpanId).toBe(spanId);
  expect(fetchSpan?.parentSpanId).toBe(load?.spanId);
  expect(fetchSpan?.attributes["http.response.status_code"]).toBe(200);
  expect(load?.attributes).toEqual({ "url.path": "/page/instrumentation-docload", "url.scheme": "http" });
  const names = load?.events.map((e) => e.name) ?? [];
  expect(names).toContain("domContentLoadedEventEnd");
  expect(names.at(-1)).toBe("loadEventEnd");
  expect(load?.endMs).toBeGreaterThanOrEqual(fetchSpan?.endMs ?? Number.POSITIVE_INFINITY);
});

test("without Server-Timing documentLoad is a root span", async ({ page }) => {
  await openDocLoad(page, "");
  await page.evaluate(() => (globalThis as unknown as { __docload: DocLoadApi }).__docload.done());
  const load = (await docLoadSpans(page)).find((s) => s.name === "documentLoad");
  expect(load).toBeDefined();
  expect(load?.parentSpanId).toBeUndefined();
});

test("a grant after load records documentLoad with times before the grant", async ({ page }) => {
  await openDocLoad(page, "?consent=pending");
  await page.waitForFunction(() => (globalThis as unknown as { __docload: DocLoadApi }).__docload.loaded());
  await page.waitForTimeout(300);
  expect(await docLoadSpans(page)).toEqual([]);
  expect(
    await page.evaluate(() => (globalThis as unknown as { __docload: DocLoadApi }).__docload.finished()),
  ).toBe(false);
  const grantedAt = await page.evaluate(() =>
    (globalThis as unknown as { __docload: DocLoadApi }).__docload.grant(),
  );
  await page.evaluate(() => (globalThis as unknown as { __docload: DocLoadApi }).__docload.done());
  const load = (await docLoadSpans(page)).find((s) => s.name === "documentLoad");
  expect(load).toBeDefined();
  expect(load?.endMs).toBeLessThan(grantedAt);
  expect(load?.startMs).toBeLessThan(load?.endMs ?? 0);
});

test("a page hidden before the grant records no documentLoad", async ({ page }) => {
  await openDocLoad(page, "?consent=pending");
  await page.waitForFunction(() => (globalThis as unknown as { __docload: DocLoadApi }).__docload.loaded());
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.evaluate(() => (globalThis as unknown as { __docload: DocLoadApi }).__docload.done());
  await page.evaluate(() => (globalThis as unknown as { __docload: DocLoadApi }).__docload.grant());
  expect(await docLoadSpans(page)).toEqual([]);
});
