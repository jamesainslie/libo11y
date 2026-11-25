/**
 * Contract, frozen by the L4 scaffold. Owned by WP5.
 *
 * The slice of the extension API libo11y uses, typed by hand so the package needs no @types/chrome
 * and tests can pass a fake. Chrome and Firefox both expose it as `chrome` in Manifest V3, with
 * promise-returning methods.
 */

/** Who sent a runtime message. */
export interface MessageSenderLike {
  /** The sending extension's ID. */
  readonly id?: string;
  /** The sending tab, for a content script. */
  readonly tab?: { readonly id?: number };
  readonly frameId?: number;
  readonly url?: string;
  readonly origin?: string;
}

/** A runtime.onMessage listener: return true to answer asynchronously through sendResponse. */
export type RuntimeMessageListener = (
  message: unknown,
  sender: MessageSenderLike,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

/** A storage area change, as storage.onChanged reports it. */
export interface StorageChangeLike {
  readonly oldValue?: unknown;
  readonly newValue?: unknown;
}

/** An extension event. */
export interface ExtensionEvent<L> {
  addListener(listener: L): void;
  removeListener(listener: L): void;
}

/** The extension API slice. */
export interface ChromeLike {
  readonly runtime: {
    readonly id: string;
    getManifest(): { readonly name: string; readonly version: string };
    sendMessage(message: unknown): Promise<unknown>;
    readonly onMessage: ExtensionEvent<RuntimeMessageListener>;
  };
  /** Absent in content scripts. */
  readonly tabs?: {
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  /** Needs the "storage" permission. */
  readonly storage?: {
    readonly local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
    readonly onChanged: ExtensionEvent<
      (changes: Record<string, StorageChangeLike>, areaName: string) => void
    >;
  };
}

/** globalThis.chrome, else globalThis.browser, else undefined. */
export function getChrome(): ChromeLike | undefined {
  const g = globalThis as { chrome?: ChromeLike; browser?: ChromeLike };
  return g.chrome?.runtime !== undefined
    ? g.chrome
    : g.browser?.runtime !== undefined
      ? g.browser
      : undefined;
}
