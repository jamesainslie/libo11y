/**
 * Reading `Server-Timing: traceparent;desc="..."` from a timing entry.
 */
import type { SpanContext } from "@opentelemetry/api";

/** The Server-Timing fields a PerformanceResourceTiming exposes. */
export interface ServerTimingLike {
  readonly name: string;
  readonly description: string;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

/**
 * The remote span context a valid version-00 traceparent names (lowercase hex, non-zero ids), or
 * undefined. Internal: the document-load span adopts it as its parent.
 */
export function remoteParentFromTraceparent(traceparent: string): SpanContext | undefined {
  const m = TRACEPARENT.exec(traceparent);
  if (m === null) return undefined;
  const [, traceId, spanId, flags] = m as unknown as [string, string, string, string];
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;
  return { traceId, spanId, traceFlags: Number.parseInt(flags, 16), isRemote: true };
}

/**
 * The traceparent the server sent: the description of the first entry named "traceparent" whose
 * description is a valid W3C traceparent (version 00, non-zero ids, lowercase hex). Undefined
 * otherwise.
 */
export function traceparentFromServerTiming(entries: readonly ServerTimingLike[]): string | undefined {
  for (const entry of entries) {
    if (entry.name === "traceparent" && remoteParentFromTraceparent(entry.description) !== undefined) {
      return entry.description;
    }
  }
  return undefined;
}
