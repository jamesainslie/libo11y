import { expect, test } from "@playwright/test";
import { createSink } from "../../web/browser/harness/sink.ts";
import { type BenchVariant, openBench } from "./harness/bench.ts";

// The overhead benchmark runs only in CI's ts-bench job, so this checks its fixture page with one
// navigation per case: a page that never gets ready would otherwise surface only there.
for (const variant of ["bare", "rum", "replay"] as const satisfies readonly BenchVariant[]) {
  test(`the overhead benchmark fixture gets ready as ${variant}`, async ({ page, request, baseURL }) => {
    const sink = createSink(request, baseURL ?? "");
    await openBench(page, variant, sink.endpoint);
    const started = await page.evaluate(() => "__rum" in globalThis);
    expect(started).toBe(variant !== "bare");
  });
}
