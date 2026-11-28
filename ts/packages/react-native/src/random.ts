/** The random source React Native IDs come from. */
import type { UuidCrypto } from "@libo11y/web/portable";

/**
 * A source for randomUuid: the app's getRandomValues (such as expo-crypto's), else the runtime's
 * crypto when it has getRandomValues, else an empty source, from which randomUuid uses Math.random.
 * Hermes has no Web Crypto. These IDs are not secrets.
 */
export function uuidCrypto(getRandomValues?: (array: Uint8Array) => Uint8Array): Partial<UuidCrypto> {
  if (getRandomValues !== undefined) {
    return {
      getRandomValues: (a) => {
        getRandomValues(a);
        return a;
      },
    };
  }
  const c = (globalThis as { crypto?: Partial<UuidCrypto> }).crypto;
  return typeof c?.getRandomValues === "function" ? c : {};
}
