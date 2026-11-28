import type { RumTelemetry } from "@libo11y/rum";
import { expect, test } from "@playwright/test";
import { logRecords, startRum } from "../../rum/browser/harness/page.ts";
import { createSink } from "../../web/browser/harness/sink.ts";

type FixtureWindow = { __rum: { telemetry: RumTelemetry } };

test("a render error is one o11y.rum.error with source boundary and the component stack", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await startRum(page, "react-boundary", { endpoint: sink.endpoint });
  await page.click('[data-o11y="Break"]');
  await expect(page.locator("#fallback")).toHaveText("Something broke: Error: render failed");
  await page.waitForTimeout(300);
  await page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum.telemetry.forceFlush());
  const got = await sink.waitFor((r) => logRecords(r).some((l) => l.eventName === "o11y.rum.error"));
  const errs = logRecords(got).filter((l) => l.eventName === "o11y.rum.error");
  expect(errs).toHaveLength(1);
  expect(errs[0]?.attributes["o11y.rum.error.source"]).toBe("boundary");
  expect(errs[0]?.attributes["exception.message"]).toBe("render failed");
  expect(String(errs[0]?.attributes["exception.stacktrace"])).toContain("Broken");
});
