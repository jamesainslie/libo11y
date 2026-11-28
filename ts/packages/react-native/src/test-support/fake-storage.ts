/** A KeyValueStorage over a Map for tests: it counts writes and can be told to fail. Never built. */
import type { KeyValueStorage } from "../contracts/storage.ts";

export type StorageMethod = keyof KeyValueStorage;

export interface FakeStorage extends KeyValueStorage {
  /** The stored values, for tests to read and change directly. */
  readonly map: Map<string, string>;
  /** How many setItem and removeItem calls reached the storage. */
  writes(): number;
  /** Makes every later call of method reject, until heal. */
  fail(method: StorageMethod): void;
  /** Stops every failure fail started. */
  heal(): void;
}

export function fakeStorage(): FakeStorage {
  const map = new Map<string, string>();
  const failing = new Set<StorageMethod>();
  let writes = 0;
  const run = <T>(method: StorageMethod, fn: () => T): Promise<T> =>
    failing.has(method) ? Promise.reject(new Error(`fake storage: ${method} failed`)) : Promise.resolve(fn());
  return {
    map,
    getItem: (k) => run("getItem", () => map.get(k) ?? null),
    setItem: (k, v) =>
      run("setItem", () => {
        writes++;
        map.set(k, v);
      }),
    removeItem: (k) =>
      run("removeItem", () => {
        writes++;
        map.delete(k);
      }),
    getAllKeys: () => run("getAllKeys", () => [...map.keys()]),
    writes: () => writes,
    fail: (m) => failing.add(m),
    heal: () => failing.clear(),
  };
}
