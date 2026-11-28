/**
 * The RUM overhead benchmark (CI only). For each of RUNS runs it opens the bench fixture without
 * RUM, with RUM (every collector, vitals, resources and long animation frames included), and with
 * RUM and replay() (default options), in an order that rotates each run, and reads Chromium's
 * main-thread TaskDuration through the DevTools protocol before and after VIEWS soft navigations,
 * and separately before and after CLICKS clicks. The overhead per view is the median over runs of
 * (with - without) / VIEWS, per interaction (with - without) / CLICKS, in milliseconds. Replay's
 * overhead is the same over RUM alone: (with replay - with RUM). It writes
 * dist/bench/overhead.json for scripts/overhead-report.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Page, test } from "@playwright/test";
import { createSink } from "../../../web/browser/harness/sink.ts";
import { type BenchVariant, openBench } from "../harness/bench.ts";

const RUNS = 5;
const VIEWS = 20;
const CLICKS = 50;
/** Long enough for RUM's render detection (100 ms of quiet, then a paint) to finish each view. */
const VIEW_SETTLE_MILLIS = 250;
const CLICK_SETTLE_MILLIS = 150;
const OUT = resolve(import.meta.dirname, "..", "..", "..", "..", "dist", "bench", "overhead.json");

interface Totals {
  views: number;
  interactions: number;
}

async function taskMillis(
  page: Page,
  cdp: Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>>,
) {
  const { metrics } = (await cdp.send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  const task = metrics.find((m) => m.name === "TaskDuration");
  if (task === undefined) throw new Error(`no TaskDuration metric on ${page.url()}`);
  return task.value * 1000;
}

async function measure(page: Page, variant: BenchVariant, endpoint: string): Promise<Totals> {
  await openBench(page, variant, endpoint);
  await page.waitForTimeout(500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const v0 = await taskMillis(page, cdp);
  for (let i = 0; i < VIEWS; i++) {
    await page.evaluate((n) => (globalThis as unknown as { __navigate(n: number): void }).__navigate(n), i);
    await page.waitForTimeout(VIEW_SETTLE_MILLIS);
  }
  const v1 = await taskMillis(page, cdp);
  for (let i = 0; i < CLICKS; i++) {
    await page.click("#update");
    await page.waitForTimeout(CLICK_SETTLE_MILLIS);
  }
  const c1 = await taskMillis(page, cdp);
  await cdp.detach();
  return { views: v1 - v0, interactions: c1 - v1 };
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

// A benchmark loads the machine it runs on, so it runs in CI, or where LIBO11Y_BENCH=1 says the
// machine's owner agreed.
test.skip(
  process.env.CI === undefined && process.env.LIBO11Y_BENCH !== "1",
  "a benchmark: CI runs it; set LIBO11Y_BENCH=1 to run it on a machine whose owner agreed",
);

const VARIANTS: readonly BenchVariant[] = ["bare", "rum", "replay"];

test("RUM and replay overhead per view and per interaction", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  const totals: Record<BenchVariant, Totals[]> = { bare: [], rum: [], replay: [] };
  for (let run = 0; run < RUNS; run++) {
    // Rotate the order, so warm-up and drift do not favor one variant.
    for (let k = 0; k < VARIANTS.length; k++) {
      const variant = VARIANTS[(run + k) % VARIANTS.length] ?? "bare";
      totals[variant].push(await measure(page, variant, sink.endpoint));
    }
  }
  const { bare: without, rum: withRum, replay: withReplay } = totals;
  const perView = without.map((w, i) => ((withRum[i]?.views ?? 0) - w.views) / VIEWS);
  const perClick = without.map((w, i) => ((withRum[i]?.interactions ?? 0) - w.interactions) / CLICKS);
  const replayPerView = withRum.map((r, i) => ((withReplay[i]?.views ?? 0) - r.views) / VIEWS);
  const replayPerClick = withRum.map(
    (r, i) => ((withReplay[i]?.interactions ?? 0) - r.interactions) / CLICKS,
  );
  const result = {
    browser: `chromium ${page.context().browser()?.version() ?? "unknown"}`,
    runs: RUNS,
    viewMillis: median(perView),
    interactionMillis: median(perClick),
    baseline: {
      views: median(without.map((t) => t.views)),
      interactions: median(without.map((t) => t.interactions)),
    },
    withRum: {
      views: median(withRum.map((t) => t.views)),
      interactions: median(withRum.map((t) => t.interactions)),
    },
    replayViewMillis: median(replayPerView),
    replayInteractionMillis: median(replayPerClick),
    withReplay: {
      views: median(withReplay.map((t) => t.views)),
      interactions: median(withReplay.map((t) => t.interactions)),
    },
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
});
