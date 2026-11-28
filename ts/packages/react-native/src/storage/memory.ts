/** The default KeyValueStorage: a Map, lost when the app stops. */
import type { KeyValueStorage } from "../contracts/storage.ts";

/**
 * A KeyValueStorage in memory. setupReactNative uses one when no storage is given, so batches still
 * retry while the app runs, but nothing outlives the process.
 */
export function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => Promise.resolve(map.get(k) ?? null),
    setItem: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
    removeItem: (k) => {
      map.delete(k);
      return Promise.resolve();
    },
    getAllKeys: () => Promise.resolve([...map.keys()]),
  };
}
