/**
 * Opening the extension's session area to content scripts. A module of its own, which imports
 * nothing, so the @libo11y/rum/webext entry reaches it before the extension setup and the bundle
 * keeps its module order.
 */
import type { ChromeSessionStorageLike } from "./chrome.ts";

/**
 * Lets content scripts read and write chrome.storage.session, so they share the extension's RUM
 * session. Call it in the service worker on every wake. It opens the whole session area to content
 * scripts, so keep nothing there that the pages a content script runs on must not reach. Resolves
 * where the browser has no setAccessLevel.
 */
export async function allowRumSessionInContentScripts(chrome: ChromeSessionStorageLike): Promise<void> {
  await chrome.storage?.session?.setAccessLevel?.({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
}
