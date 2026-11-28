/**
 * The RUM session on device storage (decision N9). An app is one JavaScript context, so no other
 * context changes the session and onChange never fires. The record is the web's ({ v: 1, ...state }
 * under SESSION_STORAGE_KEY), so a relaunch within the idle window continues the session, as a
 * reload does on the web. Writes run one after another in call order, and a load waits for those
 * already made, so a revoke's removal is never read back. The session manager first uses the store
 * when consent is granted, so nothing is read or written before.
 */
import type { KeyValueStorage } from "@libo11y/react-native";
import { parseSessionState, SESSION_STORAGE_KEY, type SessionStore } from "@libo11y/rum/core";
import { diag } from "@opentelemetry/api";

/** A SessionStore over storage. */
export function storageSessionStore(storage: KeyValueStorage): SessionStore {
  /** The last write, settled: every write and load runs after it. */
  let last: Promise<void> = Promise.resolve();
  return {
    async load() {
      await last;
      try {
        const raw = await storage.getItem(SESSION_STORAGE_KEY);
        return raw === null ? undefined : parseSessionState(JSON.parse(raw));
      } catch {
        return undefined;
      }
    },
    save(state) {
      const write = (): Promise<void> =>
        state === undefined
          ? storage.removeItem(SESSION_STORAGE_KEY)
          : storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ v: 1, ...state }));
      last = last.then(write).catch((err: unknown) => diag.warn("o11y: rum: saving the session failed", err));
    },
    onChange: () => () => {},
    close: () => {},
  };
}
