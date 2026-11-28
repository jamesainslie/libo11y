/** Opens the overhead benchmark fixture and fails fast when it never gets ready. Runs on Node inside Playwright. */
import type { Page } from "@playwright/test";

/** How long the bench fixture gets to set __benchReady before the open fails. */
export const BENCH_READY_MILLIS = 15_000;

type BenchWindow = { __benchReady?: boolean; __benchError?: string };

/**
 * Opens /page/rum-bench, with RUM when rum is true, and waits for the page to set
 * window.__benchReady. It throws within BENCH_READY_MILLIS when the page reports a setup error
 * (window.__benchError) or never gets ready, with the page's errors and console errors in the
 * message.
 */
export async function openBench(page: Page, rum: boolean, endpoint: string): Promise<void> {
  const problems: string[] = [];
  const onPageError = (e: Error): void => {
    problems.push(`pageerror: ${e.message}`);
  };
  const onConsole = (m: { type(): string; text(): string }): void => {
    if (m.type() === "error" || m.type() === "warning") problems.push(`console.${m.type()}: ${m.text()}`);
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  try {
    const q = new URLSearchParams({ endpoint, ...(rum ? { rum: "1" } : {}) });
    await page.goto(`/page/rum-bench?${q.toString()}`);
    try {
      await page.waitForFunction(
        () => {
          const w = globalThis as unknown as BenchWindow;
          return w.__benchReady === true || w.__benchError !== undefined;
        },
        null,
        { timeout: BENCH_READY_MILLIS },
      );
    } catch {
      throw new Error(benchMessage(`not ready after ${BENCH_READY_MILLIS} ms`, rum, problems));
    }
    const error = await page.evaluate(() => (globalThis as unknown as BenchWindow).__benchError);
    if (error !== undefined) throw new Error(benchMessage(`setup failed: ${error}`, rum, problems));
  } finally {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
  }
}

function benchMessage(what: string, rum: boolean, problems: readonly string[]): string {
  const detail = problems.length === 0 ? "no page errors or console errors" : problems.join("\n  ");
  return `bench fixture (${rum ? "with" : "without"} RUM) ${what}\n  ${detail}`;
}
