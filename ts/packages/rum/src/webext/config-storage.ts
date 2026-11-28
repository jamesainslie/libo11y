/**
 * The remote configuration cache in an extension: chrome.storage.local, shared by every context of
 * the extension and never the host page's localStorage. Remote configuration reads its cache
 * synchronously, so this reads the stored value once, keeps it in memory and follows other
 * contexts' writes through storage.onChanged. Writes go to memory at once and to storage after.
 */
import { diag } from "@opentelemetry/api";
import { CONFIG_STORAGE_KEY } from "../config/remote.ts";
import type { RumChromeLike, StorageChangeListener } from "./chrome.ts";

/** The synchronous storage remote configuration caches in. */
export type ConfigStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** A cache over chrome.storage.local once the stored value is read, or undefined without the area. Never rejects. */
export async function chromeConfigStorage(
  chrome: RumChromeLike,
): Promise<(ConfigStorage & { close(): void }) | undefined> {
  const area = chrome.storage?.local;
  if (area === undefined) return undefined;
  const values = new Map<string, string>();
  try {
    const stored = (await area.get(CONFIG_STORAGE_KEY))[CONFIG_STORAGE_KEY];
    if (typeof stored === "string") values.set(CONFIG_STORAGE_KEY, stored);
  } catch (err) {
    diag.debug("o11y: rum: remote configuration cache unreadable", err);
  }
  const onChanged: StorageChangeListener = (changes, areaName) => {
    if (areaName !== "local" || !(CONFIG_STORAGE_KEY in changes)) return;
    const next = changes[CONFIG_STORAGE_KEY]?.newValue;
    if (typeof next === "string") values.set(CONFIG_STORAGE_KEY, next);
    else values.delete(CONFIG_STORAGE_KEY);
  };
  chrome.storage?.onChanged.addListener(onChanged);
  const failed = (err: unknown): void =>
    diag.debug("o11y: rum: remote configuration cache write failed", err);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      values.set(key, value);
      area.set({ [key]: value }).catch(failed);
    },
    removeItem(key) {
      values.delete(key);
      area.remove(key).catch(failed);
    },
    /** Stops following other contexts' writes. */
    close: () => chrome.storage?.onChanged.removeListener(onChanged),
  };
}
