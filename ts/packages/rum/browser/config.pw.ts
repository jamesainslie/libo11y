import type { RumTelemetry } from "@libo11y/rum";
import { expect, type Page, test } from "@playwright/test";
import { createSink } from "../../web/browser/harness/sink.ts";
import { logRecords, rerunRum, spans, startRum } from "./harness/page.ts";

type FixtureWindow = { __rum: { telemetry: RumTelemetry } };

function forceFlush(page: Page): Promise<unknown> {
  return page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum.telemetry.forceFlush());
}

function cached(page: Page, version: string): Promise<unknown> {
  return page.waitForFunction(
    (v) => (localStorage.getItem("libo11y.rum.config") ?? "").includes(`"version":"${v}"`),
    version,
  );
}

test("a cached remote configuration configures the next session, and enabled false stops RUM at once", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await sink.setConfig({ version: "c1", config: { enabled: true, collectors: { actions: false } } });
  const opts = {
    endpoint: sink.endpoint,
    collectors: ["views", "actions"],
    remoteConfig: { refreshMillis: 500 },
  };
  await startRum(page, "config", opts);
  await cached(page, "c1");

  // The next session takes c1: actions are off, views still record.
  await page.evaluate(() => localStorage.removeItem("libo11y.rum.session"));
  await page.reload();
  await rerunRum(page, opts);
  await page.click('[data-o11y="Go"]');
  await page.waitForTimeout(500);
  await forceFlush(page);
  const got = await sink.waitFor((r) =>
    logRecords(r).some(
      (l) => l.eventName === "o11y.rum.session.start" && l.attributes["o11y.rum.config.version"] === "c1",
    ),
  );
  expect(spans(got).filter((s) => s.name === "action click")).toEqual([]);
  await sink.waitFor((r) => spans(r).some((s) => s.name === "view /page/rum-config"));

  // The kill switch: nothing but what was already pending is sent afterwards.
  await sink.setConfig({ version: "c2", config: { enabled: false } });
  await cached(page, "c2");
  await page.waitForTimeout(300);
  await forceFlush(page);
  const before = (await sink.received()).length;
  await page.click('[data-o11y="Go"]');
  await page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum.telemetry.rum.addAction("Later"));
  await page.waitForTimeout(500);
  await forceFlush(page);
  await page.waitForTimeout(300);
  expect((await sink.received()).length).toBe(before);
  expect(await sink.configRequests()).toBeGreaterThanOrEqual(3);
});
