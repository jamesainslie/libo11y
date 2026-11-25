/**
 * WP4 (instrumentation). Reading `Server-Timing: traceparent;desc="..."` from a timing entry.
 */

/** The Server-Timing fields a PerformanceResourceTiming exposes. */
export interface ServerTimingLike {
  readonly name: string;
  readonly description: string;
}

/**
 * The traceparent the server sent: the description of the first entry named "traceparent" whose
 * description is a valid W3C traceparent (version 00, non-zero ids, lowercase hex). Undefined
 * otherwise.
 */
export function traceparentFromServerTiming(entries: readonly ServerTimingLike[]): string | undefined {
  void entries;
  throw new Error("not implemented");
}
