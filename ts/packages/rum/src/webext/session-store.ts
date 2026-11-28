/**
 * The extension session store (decision P20): the session record in chrome.storage.session, which
 * every context of the extension shares and the browser clears when it closes, and
 * storage.onChanged, which tells the other contexts of a save. Records are the web store's version
 * 1 JSON plus w, a token naming the store that wrote it, so a store ignores its own saves when the
 * change event comes back to it.
 *
 * Content scripts reach chrome.storage.session only once the service worker opened it to them
 * (allowRumSessionInContentScripts). Until then each content script's store only keeps its session
 * in memory, so it starts sessions of its own.
 */
import { diag } from "@opentelemetry/api";
import type { SessionState, SessionStore } from "../contracts/session.ts";
import { randomUuid } from "../ids.ts";
import { parseSessionState, SESSION_STORAGE_KEY } from "../session/local-store.ts";
import type { ChromeSessionStorageLike, StorageChangeListener } from "./chrome.ts";

/**
 * Lets content scripts read and write chrome.storage.session, so they share the extension's RUM
 * session. Call it in the service worker on every wake. It opens the whole session area to content
 * scripts, so keep nothing there that the pages a content script runs on must not reach. Resolves
 * where the browser has no setAccessLevel.
 */
export async function allowRumSessionInContentScripts(chrome: ChromeSessionStorageLike): Promise<void> {
  await chrome.storage?.session?.setAccessLevel?.({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
}

/** The extension SessionStore. Storage is reached on first use, which the session manager makes only after consent. */
export function chromeSessionStore(chrome: ChromeSessionStorageLike): SessionStore {
  const token = randomUuid();
  const area = chrome.storage?.session;
  const listeners = new Set<(s: SessionState | undefined) => void>();
  let warned = false;
  const failed = (what: string, err: unknown): void => {
    if (warned) {
      diag.debug(`o11y: rum: chrome.storage.session ${what} failed`, err);
      return;
    }
    warned = true;
    diag.warn(
      `o11y: rum: chrome.storage.session ${what} failed; in a content script, call allowRumSessionInContentScripts in the worker`,
      err,
    );
  };
  const onChanged: StorageChangeListener = (changes, areaName) => {
    if (areaName !== "session" || !(SESSION_STORAGE_KEY in changes)) return;
    const next = changes[SESSION_STORAGE_KEY]?.newValue;
    if (next === undefined) {
      for (const l of listeners) l(undefined);
      return;
    }
    if ((next as { w?: unknown } | null)?.w === token) return; // this store's own save
    const s = parseSessionState(next);
    if (s === undefined) return;
    for (const l of listeners) l(s);
  };
  let listening = false;
  const listen = (): void => {
    if (listening) return;
    listening = true;
    chrome.storage?.onChanged.addListener(onChanged);
  };
  return {
    async load() {
      listen();
      if (area === undefined) return undefined;
      try {
        const items = await area.get(SESSION_STORAGE_KEY);
        return parseSessionState(items[SESSION_STORAGE_KEY]);
      } catch (err) {
        failed("read", err);
        return undefined;
      }
    },
    save(state) {
      listen();
      if (area === undefined) return;
      try {
        const write =
          state === undefined
            ? area.remove(SESSION_STORAGE_KEY)
            : area.set({ [SESSION_STORAGE_KEY]: { v: 1, ...state, w: token } });
        write.catch((err: unknown) => failed("write", err));
      } catch (err) {
        failed("write", err);
      }
    },
    onChange(listener) {
      listen();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (listening) chrome.storage?.onChanged.removeListener(onChanged);
      listening = false;
      listeners.clear();
    },
  };
}
