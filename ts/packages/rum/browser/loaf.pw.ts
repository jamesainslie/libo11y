import { expect, test } from "@playwright/test";
import { createSink } from "../../web/browser/harness/sink.ts";
import { logRecords, startRum } from "./harness/page.ts";

test("a long animation frame counts in the view summary where the engine reports them", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await startRum(page, "perf", { endpoint: sink.endpoint, collectors: ["long_animation_frames"] });
  const supported = await page.evaluate(() =>
    (PerformanceObserver.supportedEntryTypes ?? []).includes("long-animation-frame"),
  );
  await page.click('[data-o11y="Slow"]');
  await expect(page.locator('[data-o11y="Slow"]')).toHaveText("Done");
  await page.waitForTimeout(300);
  await page.goto("about:blank");
  const got = await sink.waitFor((r) => logRecords(r).some((l) => l.eventName === "o11y.rum.view.summary"));
  const summary = logRecords(got).find(
    (l) => l.eventName === "o11y.rum.view.summary" && l.attributes["o11y.rum.summary.seq"] === 0,
  );
  const count = summary?.attributes["o11y.rum.summary.long_animation_frames"];
  if (supported) expect(count).toBeGreaterThanOrEqual(1);
  else expect(count).toBeUndefined();
});
