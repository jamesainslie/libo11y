/**
 * WP4 (instrumentation). The propagation allow-list and the ignore list.
 */
import type { OriginMatcher, UrlMatcher } from "../options.ts";

/** The opaque origin's serialization, which never matches anything. */
const OPAQUE = "null";

/** Tests a RegExp from its start, so a global or sticky one does not carry lastIndex between calls. */
function matches(re: RegExp, s: string): boolean {
  re.lastIndex = 0;
  return re.test(s);
}

/** The origin of s, or undefined when s is not an absolute URL. */
function originOf(s: string): string | undefined {
  try {
    return new URL(s).origin;
  } catch {
    return undefined;
  }
}

/** The page's origin, when there is a page. */
function currentOrigin(): string | undefined {
  return (globalThis as { location?: { origin?: string } }).location?.origin;
}

/**
 * True when url may receive trace context: its origin equals pageOrigin, or matches one entry of
 * allow (a string compared to url.origin exactly, after normalizing it through new URL(s).origin;
 * a RegExp tested against url.origin). An opaque origin ("null") never matches. pageOrigin
 * defaults to globalThis.location?.origin.
 */
export function shouldPropagate(url: URL, allow: readonly OriginMatcher[], pageOrigin?: string): boolean {
  const origin = url.origin;
  if (origin === OPAQUE) return false;
  const page = pageOrigin ?? currentOrigin();
  if (page !== undefined && page !== OPAQUE && origin === page) return true;
  for (const entry of allow) {
    if (typeof entry === "string" ? originOf(entry) === origin : matches(entry, origin)) return true;
  }
  return false;
}

/** True when url.href starts with a string entry or matches a RegExp entry. */
export function isIgnored(url: URL, ignore: readonly UrlMatcher[]): boolean {
  const href = url.href;
  for (const entry of ignore) {
    if (typeof entry === "string" ? href.startsWith(entry) : matches(entry, href)) return true;
  }
  return false;
}
