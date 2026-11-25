/**
 * WP1 (transport). Retry-After parsing and backoff.
 */

/** The HTTP statuses worth retrying, as the OTLP specification lists them. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 502, 503, 504]);

/**
 * The delay a Retry-After header asks for, in milliseconds: delta-seconds, or an HTTP-date minus
 * now. Undefined for a missing, negative or malformed value. A date in the past is 0.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  void value;
  void now;
  throw new Error("not implemented");
}

/**
 * The delay before retry number attempts (1 for the first retry): full jitter over
 * min(maxMillis, initialMillis * 2 ** (attempts - 1)), that is random() times the cap.
 */
export function backoffDelay(
  attempts: number,
  initialMillis: number,
  maxMillis: number,
  random: () => number,
): number {
  void attempts;
  void initialMillis;
  void maxMillis;
  void random;
  throw new Error("not implemented");
}
