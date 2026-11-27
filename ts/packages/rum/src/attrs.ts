/** Attribute keys RUM uses that the generator does not mint as constants, and the summary key builders. */
import type { SummaryCountKey, VitalName } from "./contracts/summary.ts";

/** semconv session.id. */
export const ATTR_SESSION_ID = "session.id";
/** semconv user.id, set by identify(). The app registry classifies it. */
export const ATTR_USER_ID = "user.id";

/** The summary attribute for a count, such as o11y.rum.summary.errors.uncaught. */
export function summaryCountKey(key: SummaryCountKey): string {
  return `o11y.rum.summary.${key}`;
}

/** The summary attribute for a vital's value, such as o11y.rum.summary.lcp.value. */
export function summaryVitalKey(name: VitalName): string {
  return `o11y.rum.summary.${name}.value`;
}
