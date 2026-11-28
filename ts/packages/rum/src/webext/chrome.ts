/**
 * The slice of the extension API RUM uses in extension contexts, typed by hand as @libo11y/webext
 * types its own, so tests can pass a fake.
 */

/** A storage area: chrome.storage.local or chrome.storage.session. */
export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** A storage change, as storage.onChanged reports it. */
export type StorageChanges = Record<string, { readonly oldValue?: unknown; readonly newValue?: unknown }>;

/** A storage.onChanged listener. */
export type StorageChangeListener = (changes: StorageChanges, areaName: string) => void;

/** chrome.storage.session and the change event, as the session store uses them. */
export interface ChromeSessionStorageLike {
  readonly storage?: {
    readonly session?: StorageAreaLike & {
      /** Chrome 102 and Firefox 129 on; absent before. */
      setAccessLevel?(o: {
        readonly accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" | "TRUSTED_CONTEXTS";
      }): Promise<void>;
    };
    readonly onChanged: {
      addListener(listener: StorageChangeListener): void;
      removeListener(listener: StorageChangeListener): void;
    };
  };
}

/** The extension API slice setupRumExtension reads. */
export interface RumChromeLike extends ChromeSessionStorageLike {
  readonly runtime: {
    readonly id: string;
    /** The URL of a file in the extension, getURL("") its base. */
    getURL?(path: string): string;
  };
  readonly storage?: ChromeSessionStorageLike["storage"] & { readonly local?: StorageAreaLike };
}

/** globalThis.chrome, else globalThis.browser, as @libo11y/webext finds it. */
export function getRumChrome(): RumChromeLike | undefined {
  const g = globalThis as { chrome?: RumChromeLike; browser?: RumChromeLike };
  return g.chrome?.runtime !== undefined
    ? g.chrome
    : g.browser?.runtime !== undefined
      ? g.browser
      : undefined;
}
