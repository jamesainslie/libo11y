/** Random IDs for sessions and views. */

/**
 * A random UUIDv4. crypto.randomUUID needs a secure context, so an http page that is not
 * localhost falls back to crypto.getRandomValues, which every context has.
 */
export function randomUuid(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function" && globalThis.isSecureContext !== false) return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
