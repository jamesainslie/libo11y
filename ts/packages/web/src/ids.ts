/** Random bytes and UUIDs on every runtime libo11y's client packages run on, Hermes included. */

/** The slice of Web Crypto randomBytes and randomUuid use. */
export interface UuidCrypto {
  randomUUID?(): string;
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
}

/**
 * n random bytes from c.getRandomValues, else from random (default Math.random) on a runtime
 * without Web Crypto, such as React Native on Hermes. These bytes are for IDs, never for secrets.
 * Internal.
 */
export function randomBytes(
  n: number,
  c: Partial<UuidCrypto> | undefined = globalThis.crypto,
  random: () => number = Math.random,
): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  if (typeof c?.getRandomValues === "function") return c.getRandomValues(b);
  for (let i = 0; i < n; i++) b[i] = random() * 256;
  return b;
}

/**
 * A random lowercase v4 UUID: c.randomUUID where it exists (secure contexts), else one built from
 * randomBytes as RFC 9562 section 5.4 lays out. Internal.
 */
export function randomUuid(
  c: Partial<UuidCrypto> | undefined = globalThis.crypto,
  random?: () => number,
): string {
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = randomBytes(16, c, random);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
