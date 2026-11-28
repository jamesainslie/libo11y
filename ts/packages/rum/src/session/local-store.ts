/**
 * The web session store: the record in localStorage, so a reload and every tab of the origin read
 * it, and a BroadcastChannel, so other tabs hear a change at once. Saves are versioned JSON.
 */
import { diag } from "@opentelemetry/api";
import type { SessionState, SessionStore } from "../contracts/session.ts";
import { parseSessionState, SESSION_STORAGE_KEY } from "./state.ts";

export { parseSessionState, SESSION_STORAGE_KEY } from "./state.ts";

export const SESSION_CHANNEL = "libo11y.rum";

/** The part of BroadcastChannel the store uses. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  close(): void;
}

export interface LocalSessionStoreOptions {
  /** Default globalThis.localStorage; absent or throwing gives a store that only broadcasts. */
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** Default new BroadcastChannel(SESSION_CHANNEL) where it exists. */
  readonly channel?: BroadcastChannelLike;
}

function defaultStorage(): LocalSessionStoreOptions["storage"] {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage;
  } catch {
    return undefined; // a sandboxed frame throws on access
  }
}

function defaultChannel(): BroadcastChannelLike | undefined {
  const BC = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike })
    .BroadcastChannel;
  return BC === undefined ? undefined : new BC(SESSION_CHANNEL);
}

/**
 * The web SessionStore. Storage and the default channel are reached on first use, which the session
 * manager makes only after consent is granted, so no BroadcastChannel exists before then.
 */
export function localStorageSessionStore(opts: LocalSessionStoreOptions = {}): SessionStore {
  let storage: LocalSessionStoreOptions["storage"];
  let channel: BroadcastChannelLike | undefined;
  let opened = false;
  const open = (): void => {
    if (opened) return;
    opened = true;
    storage = opts.storage ?? defaultStorage();
    channel = opts.channel ?? defaultChannel();
    channel?.addEventListener("message", onMessage);
  };
  const listeners = new Set<(s: SessionState | undefined) => void>();
  const onMessage = (e: { readonly data: unknown }): void => {
    const d = e.data as { session?: unknown } | null;
    if (typeof d !== "object" || d === null || !("session" in d)) return;
    const s = d.session === null ? undefined : parseSessionState(d.session);
    if (d.session !== null && s === undefined) return;
    for (const l of listeners) l(s);
  };
  return {
    async load() {
      open();
      try {
        const raw = storage?.getItem(SESSION_STORAGE_KEY);
        return raw == null ? undefined : parseSessionState(JSON.parse(raw));
      } catch (err) {
        diag.debug("o11y: rum: session storage unreadable", err);
        return undefined;
      }
    },
    save(state) {
      open();
      const record = state === undefined ? null : { v: 1, ...state };
      try {
        if (record === null) storage?.removeItem(SESSION_STORAGE_KEY);
        else storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(record));
      } catch (err) {
        diag.debug("o11y: rum: session storage write failed", err);
      }
      try {
        channel?.postMessage({ session: record });
      } catch (err) {
        diag.debug("o11y: rum: session broadcast failed", err);
      }
    },
    onChange(listener) {
      open();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      channel?.removeEventListener("message", onMessage);
      channel?.close();
      listeners.clear();
    },
  };
}
