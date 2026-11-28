/**
 * OTEL_RESOURCE_ATTRIBUTES parsing, shared by the browser resource and platforms without a page, such
 * as React Native's, which reach it through @libo11y/web/portable.
 */
import type { Attributes } from "@opentelemetry/api";

/**
 * Parses OTEL_RESOURCE_ATTRIBUTES as the specification defines it: comma-separated key=value
 * pairs, percent-decoded, whitespace trimmed; a malformed pair is skipped.
 */
export function parseResourceAttributes(raw: string | undefined): Attributes {
  const out: Attributes = {};
  if (raw === undefined) return out;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    try {
      const key = decodeURIComponent(pair.slice(0, eq).trim());
      const value = decodeURIComponent(pair.slice(eq + 1).trim());
      if (key !== "") out[key] = value;
    } catch {
      // A pair whose percent-encoding is malformed is skipped.
    }
  }
  return out;
}
