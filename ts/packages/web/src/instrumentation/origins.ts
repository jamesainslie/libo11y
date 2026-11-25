/**
 * WP4 (instrumentation). The propagation allow-list and the ignore list.
 */
import type { OriginMatcher, UrlMatcher } from "../options.ts";

/**
 * True when url may receive trace context: its origin equals pageOrigin, or matches one entry of
 * allow (a string compared to url.origin exactly, after normalizing it through new URL(s).origin;
 * a RegExp tested against url.origin). An opaque origin ("null") never matches. pageOrigin
 * defaults to globalThis.location?.origin.
 */
export function shouldPropagate(url: URL, allow: readonly OriginMatcher[], pageOrigin?: string): boolean {
  void url;
  void allow;
  void pageOrigin;
  throw new Error("not implemented");
}

/** True when url.href starts with a string entry or matches a RegExp entry. */
export function isIgnored(url: URL, ignore: readonly UrlMatcher[]): boolean {
  void url;
  void ignore;
  throw new Error("not implemented");
}
