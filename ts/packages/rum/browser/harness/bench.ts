/** Opens the overhead benchmark fixture and fails fast when it never gets ready. Runs on Node inside Playwright. */
import type { Page } from "@playwright/test";

/** How long the bench fixture gets to set __benchReady before the open fails. */
export const BENCH_READY_MILLIS = 15_000;

type BenchWindow = { __benchReady?: boolean; __benchError?: string };

/** What the bench page runs: nothing, RUM, or RUM with replay. */
export type BenchVariant = "bare" | "rum" | "replay";

/**
 * Opens the bench page (packages/rum-replay/browser/fixtures/bench.ts) as variant and waits for
 * it to set window.__benchReady. It throws within BENCH_READY_MILLIS when the page reports a
 * setup error (window.__benchError) or never gets ready, with the page's errors and console
 * errors in the message.
 */
export async function openBench(page: Page, variant: BenchVariant, endpoint: string): Promise<void> {
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
    const q = new URLSearchParams({
      endpoint,
      ...(variant === "bare" ? {} : { rum: "1" }),
      ...(variant === "replay" ? { replay: "1" } : {}),
    });
    await page.goto(`/page/rum-replay-bench?${q.toString()}`);
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
      throw new Error(benchMessage(`not ready after ${BENCH_READY_MILLIS} ms`, variant, problems));
    }
    const error = await page.evaluate(() => (globalThis as unknown as BenchWindow).__benchError);
    if (error !== undefined) throw new Error(benchMessage(`setup failed: ${error}`, variant, problems));
  } finally {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
  }
}

function benchMessage(what: string, variant: BenchVariant, problems: readonly string[]): string {
  const detail = problems.length === 0 ? "no page errors or console errors" : problems.join("\n  ");
  return `bench fixture (${variant}) ${what}\n  ${detail}`;
}
