/**
 * Random IDs for sessions and views. randomUuid is web's (@libo11y/web/portable) restated: importing
 * web here would move web's modules ahead of the extension session store, which imports this, and
 * the extension bundles compress worse in that order.
 */

/**
 * A random lowercase v4 UUID: crypto.randomUUID in a secure context, else one built from
 * crypto.getRandomValues, else from Math.random where there is no Web Crypto, as on Hermes. A
 * session or view ID is not a secret.
 */
export function randomUuid(): string {
  const c = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (typeof c?.randomUUID === "function" && globalThis.isSecureContext !== false) return c.randomUUID();
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.random() * 256;
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
