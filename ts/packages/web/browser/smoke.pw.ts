/**
 * Scaffold. The harness itself works: a page bundled from @libo11y/web loads in Chromium with no
 * errors, the sink records an OTLP request from the page origin and from the cross origin.
 */
import { expect, test } from "@playwright/test";
import { createSink } from "./harness/sink.ts";

test("a page bundled from @libo11y/web loads in Chromium", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/page/smoke");
  const probe = await page.waitForFunction(() => (globalThis as { __smoke?: unknown }).__smoke);
  const value = (await probe.jsonValue()) as {
    exports: string[];
    compressionStream: boolean;
    indexedDB: boolean;
    sendBeacon: boolean;
    secureContext: boolean;
  };
  expect(errors).toEqual([]);
  expect(value.exports).toContain("setup");
  expect(value.exports).toContain("instrumentFetch");
  expect(value.compressionStream).toBe(true);
  expect(value.indexedDB).toBe(true);
  expect(value.sendBeacon).toBe(true);
  expect(value.secureContext).toBe(true);
});

test("the sink records requests from both origins", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await page.goto("/page/smoke");
  const body = JSON.stringify({ resourceSpans: [] });
  for (const endpoint of [sink.endpoint, sink.crossOriginEndpoint]) {
    const status = await page.evaluate(
      async ([url, b]) =>
        (
          await fetch(`${url}/v1/traces`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: b,
          })
        ).status,
      [endpoint, body] as const,
    );
    expect(status).toBe(200);
  }
  const got = await sink.waitFor((r) => r.length === 2);
  expect(got.map((r) => r.origin)).toEqual([new URL(baseURL ?? "").origin, new URL(baseURL ?? "").origin]);
  expect(got[0]?.body).toEqual({ resourceSpans: [] });
});
