/** Random UUIDs on every runtime libo11y's client packages run on, Hermes included. */

/** The slice of Web Crypto randomUuid uses. */
export interface UuidCrypto {
  randomUUID?(): string;
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
}

/**
 * A random lowercase v4 UUID: c.randomUUID in a secure context (an http page that is not localhost
 * is not one), else one built from c.getRandomValues as RFC 9562 section 5.4 lays out, else from
 * Math.random on a runtime without Web Crypto, such as React Native on Hermes. These UUIDs are IDs,
 * never secrets. Internal.
 */
export function randomUuid(c: Partial<UuidCrypto> | undefined = globalThis.crypto): string {
  if (typeof c?.randomUUID === "function" && globalThis.isSecureContext !== false) return c.randomUUID();
  const b = new Uint8Array(16).map(() => Math.random() * 256);
  c?.getRandomValues?.(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
