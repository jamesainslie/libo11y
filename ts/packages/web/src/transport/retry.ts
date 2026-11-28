/**
 * Retry-After parsing and backoff.
 */

/** The HTTP statuses worth retrying, as the OTLP specification lists them. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 502, 503, 504]);

const DELTA_SECONDS = /^\d+$/;
// The three HTTP-date forms of RFC 9110: IMF-fixdate and the obsolete RFC 850 form both start with
// a day name and a comma, asctime with a day name and a month name. Date.parse alone is too
// lenient: V8 reads "1.5" or "-1" as dates.
const HTTP_DATE =
  /^(?:[A-Za-z]{3,9}, \d{1,2}[ -][A-Za-z]{3}[ -]\d{2,4} |[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} )\d{2}:\d{2}:\d{2}/;

/**
 * The delay a Retry-After header asks for, in milliseconds: delta-seconds, or an HTTP-date minus
 * now. Undefined for a missing, negative or malformed value. A date in the past is 0.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const v = value.trim();
  if (v === "") return undefined;
  if (DELTA_SECONDS.test(v)) {
    const seconds = Number(v);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
  }
  if (!HTTP_DATE.test(v)) return undefined;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
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
  const exponent = Math.max(0, attempts - 1);
  const cap = Math.min(maxMillis, initialMillis * 2 ** exponent);
  return Math.floor(random() * cap);
}
