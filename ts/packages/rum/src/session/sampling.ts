/**
 * Session sampling (design D4). The decision is a hash of session.id, so every tab of a session,
 * and every client language, agrees: kept when fnv1a32(utf8(id)) / 2^32 < rate.
 */
const encoder = new TextEncoder();

/** FNV-1a 32-bit over the UTF-8 bytes of s, as an unsigned integer. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of encoder.encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

/** Whether the session with this ID is head-sampled at rate (0..1). NaN and rates at or below 0 keep nothing. */
export function sessionSampled(sessionId: string, rate: number): boolean {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  return fnv1a32(sessionId) / 2 ** 32 < rate;
}
