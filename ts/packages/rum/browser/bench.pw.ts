import { expect, test } from "@playwright/test";
import { createSink } from "../../web/browser/harness/sink.ts";
import { openBench } from "./harness/bench.ts";

// The overhead benchmark runs only in CI's ts-bench job, so this checks its fixture page with one
// navigation per case: a page that never gets ready would otherwise surface only there.
for (const rum of [false, true]) {
  test(`the overhead benchmark fixture gets ready ${rum ? "with" : "without"} RUM`, async ({
    page,
    request,
    baseURL,
  }) => {
    const sink = createSink(request, baseURL ?? "");
    await openBench(page, rum, sink.endpoint);
    const started = await page.evaluate(() => "__rum" in globalThis);
    expect(started).toBe(rum);
  });
}
