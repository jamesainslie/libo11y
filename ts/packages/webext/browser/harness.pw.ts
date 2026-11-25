/**
 * Scaffold. The extension harness works: the test extension loads, its worker bundles
 * @libo11y/webext, stopServiceWorker terminates the worker, a message wakes a new one, and
 * IndexedDB at the extension origin survives the stop.
 */
import { expect, sendFromExtensionPage, stopServiceWorker, test } from "./harness/fixtures.ts";

test("the worker survives a stop with its IndexedDB intact", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  const first = await serviceWorker.evaluate(async () => {
    const h = (globalThis as { __harness?: { exports: string[]; wakes: Promise<number> } }).__harness;
    return { exports: h?.exports ?? [], wakes: await h?.wakes };
  });
  expect(first.exports).toContain("setupWorker");
  expect(first.wakes).toBe(1);

  expect(await sendFromExtensionPage(context, extensionId, { type: "wake" })).toEqual({ wakes: 1 });

  await stopServiceWorker(context, extensionId);
  // A fresh worker evaluates the script again and finds the count the first one stored.
  expect(await sendFromExtensionPage(context, extensionId, { type: "wake" })).toEqual({ wakes: 2 });
});

test("the content script runs on fixture pages", async ({ context }) => {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${process.env.LIBO11Y_BROWSER_PORT ?? "47311"}/page/smoke`);
  await expect(page.locator("html")).toHaveAttribute("data-libo11y-content", "loaded");
});
