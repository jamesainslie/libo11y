/**
 * Scaffold, frozen. The Playwright fixtures for the test extension: a persistent Chromium context
 * with dist/extension loaded (full Chromium in new headless mode, because the headless shell cannot
 * load extensions), its service worker and its ID, and stopServiceWorker, which terminates the
 * worker the way the browser does when it goes idle.
 */
import { resolve } from "node:path";
import { type BrowserContext, test as base, chromium, type Worker } from "@playwright/test";
import type { ChromeLike } from "../../src/chrome.ts";

// The extension API, inside page.evaluate callbacks that run in the extension page.
declare const chrome: ChromeLike;

/**
 * Extra library directories for full Chromium, joined to LD_LIBRARY_PATH for the launch. CI images
 * have the libraries (playwright install --with-deps); hosts without them, such as NixOS, set
 * LIBO11Y_CHROMIUM_LIBRARY_PATH to the directories of libcups, libcairo and libpango.
 */
function launchEnv(): Record<string, string> | undefined {
  const extra = process.env.LIBO11Y_CHROMIUM_LIBRARY_PATH;
  if (extra === undefined || extra === "") return undefined;
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  env.LD_LIBRARY_PATH = [extra, process.env.LD_LIBRARY_PATH]
    .filter((p) => p !== undefined && p !== "")
    .join(":");
  return env;
}

/** The unpacked test extension. */
export const EXTENSION_DIR: string = resolve(import.meta.dirname, "..", "dist", "extension");

export interface ExtensionFixtures {
  readonly context: BrowserContext;
  readonly serviceWorker: Worker;
  readonly extensionId: string;
}

export const test = base.extend<ExtensionFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures take their dependencies by destructuring.
  context: async ({}, use) => {
    const env = launchEnv();
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      ...(env === undefined ? {} : { env }),
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        "--host-resolver-rules=MAP localhost 127.0.0.1",
      ],
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await use(worker);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
});

export { expect } from "@playwright/test";

/**
 * Stops the extension's service worker, as Chromium does to an idle MV3 worker, through the CDP
 * ServiceWorker domain of an extension page, and resolves once CDP reports it stopped. The next
 * extension event (a runtime message, an alarm) starts a fresh worker that evaluates the script
 * again. Playwright does not report that fresh worker as a new Worker, so observe it through
 * messages (sendFromExtensionPage) and the sink, not through serviceWorker.evaluate.
 */
export async function stopServiceWorker(context: BrowserContext, extensionId: string): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/page.html`);
    const cdp = await context.newCDPSession(page);
    const status = new Map<string, string>();
    let changed: () => void = () => {};
    cdp.on("ServiceWorker.workerVersionUpdated", (e) => {
      for (const v of e.versions) {
        if (v.scriptURL.startsWith(`chrome-extension://${extensionId}/`))
          status.set(v.versionId, v.runningStatus);
      }
      changed();
    });
    await cdp.send("ServiceWorker.enable");
    const deadline = Date.now() + 10_000;
    const settle = () =>
      new Promise<void>((r) => {
        changed = r;
        setTimeout(r, 100);
      });
    while (status.size === 0 && Date.now() < deadline) await settle();
    for (const [versionId, s] of status) {
      if (s !== "stopped") await cdp.send("ServiceWorker.stopWorker", { versionId });
    }
    while ([...status.values()].some((s) => s !== "stopped")) {
      if (Date.now() > deadline) throw new Error("the service worker did not stop");
      await settle();
    }
    await cdp.detach();
  } finally {
    await page.close();
  }
}

/**
 * Sends message with chrome.runtime.sendMessage from the extension's page, which wakes a stopped
 * worker, and resolves with the worker's reply.
 */
export async function sendFromExtensionPage(
  context: BrowserContext,
  extensionId: string,
  message: unknown,
): Promise<unknown> {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/page.html`);
    return await page.evaluate((m) => chrome.runtime.sendMessage(m), message);
  } finally {
    await page.close();
  }
}
