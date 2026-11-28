/**
 * Contract. Where the persistent retry queue, and later the RUM session, live on the device.
 */

/**
 * A key-value storage of strings, with the AsyncStorage shape, so
 * `@react-native-async-storage/async-storage` satisfies it as it is. Every method may reject;
 * callers treat a rejection as a storage failure and carry on.
 */
export interface KeyValueStorage {
  /** The value stored under key, or null when there is none. */
  getItem(key: string): Promise<string | null>;
  /** Stores value under key. Resolves once the value is saved. */
  setItem(key: string, value: string): Promise<void>;
  /** Removes the value under key, if any. */
  removeItem(key: string): Promise<void>;
  /** Every key stored, the queue's and any other's. */
  getAllKeys(): Promise<readonly string[]>;
}
