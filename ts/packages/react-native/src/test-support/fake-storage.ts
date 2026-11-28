/** A KeyValueStorage over a Map for tests: it counts writes and can be told to fail. Never built. */
import type { KeyValueStorage } from "../contracts/storage.ts";

export type StorageMethod = keyof KeyValueStorage;

export interface FakeStorage extends KeyValueStorage {
  /** The stored values, for tests to read and change directly. */
  readonly map: Map<string, string>;
  /** How many setItem and removeItem calls reached the storage. */
  writes(): number;
  /** How many getItem calls asked for key. */
  reads(key: string): number;
  /** Makes every later call of method reject (only for keys match accepts, when given), until heal. */
  fail(method: StorageMethod, match?: (key: string) => boolean): void;
  /** Stops every failure fail started. */
  heal(): void;
  /** Holds every later setItem and removeItem until the returned function is called. */
  hold(): () => void;
}

export function fakeStorage(): FakeStorage {
  const map = new Map<string, string>();
  const failing = new Map<StorageMethod, (key: string) => boolean>();
  let held: Promise<void> | undefined;
  let writes = 0;
  const reads = new Map<string, number>();
  const run = <T>(method: StorageMethod, key: string, fn: () => T): Promise<T> =>
    failing.get(method)?.(key) === true
      ? Promise.reject(new Error(`fake storage: ${method} failed`))
      : Promise.resolve(fn());
  const write = async (method: StorageMethod, key: string, fn: () => void): Promise<void> => {
    if (held !== undefined) await held;
    return run(method, key, () => {
      writes++;
      fn();
    });
  };
  return {
    map,
    getItem: (k) => {
      reads.set(k, (reads.get(k) ?? 0) + 1);
      return run("getItem", k, () => map.get(k) ?? null);
    },
    setItem: (k, v) => write("setItem", k, () => map.set(k, v)),
    removeItem: (k) => write("removeItem", k, () => map.delete(k)),
    getAllKeys: () => run("getAllKeys", "", () => [...map.keys()]),
    writes: () => writes,
    reads: (k) => reads.get(k) ?? 0,
    fail: (m, match = () => true) => {
      failing.set(m, match);
    },
    heal: () => failing.clear(),
    hold: () => {
      let release: () => void = () => {};
      held = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        held = undefined;
        release();
      };
    },
  };
}
