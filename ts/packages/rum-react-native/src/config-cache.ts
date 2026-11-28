/**
 * The remote configuration cache on device storage. The remote configuration client reads its
 * cache synchronously (localStorage on the web), and device storage is asynchronous, so the cache
 * reads the listed keys once, when RUM opens remote configuration on the first grant, and serves
 * them from memory. Writes change memory at once and reach storage in the background, one after
 * another in call order; a failed write keeps the value for this run only.
 */
import type { KeyValueStorage } from "@libo11y/react-native";
import type { ConfigCacheStorage } from "@libo11y/rum/core";
import { diag } from "@opentelemetry/api";

/** A synchronous cache of keys over storage, once their stored values are read. Never rejects. */
export async function preloadedStorage(
  storage: KeyValueStorage,
  keys: readonly string[],
): Promise<ConfigCacheStorage> {
  const allowed = new Set(keys);
  const values = new Map<string, string>();
  for (const k of allowed) {
    try {
      const v = await storage.getItem(k);
      if (v !== null) values.set(k, v);
    } catch (err) {
      diag.debug("o11y: rum: remote configuration cache unreadable", err);
    }
  }
  let last: Promise<void> = Promise.resolve();
  const background = (write: () => Promise<void>): void => {
    last = last
      .then(write)
      .catch((err: unknown) => diag.debug("o11y: rum: remote configuration cache write failed", err));
  };
  return {
    getItem: (k) => (allowed.has(k) ? (values.get(k) ?? null) : null),
    setItem(k, v) {
      if (!allowed.has(k)) return;
      values.set(k, v);
      background(() => storage.setItem(k, v));
    },
    removeItem(k) {
      if (!allowed.has(k)) return;
      values.delete(k);
      background(() => storage.removeItem(k));
    },
  };
}
