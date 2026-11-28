/**
 * Server-Timing on a resource's response. A valid traceparent entry names the server span that
 * served the resource, which the resource span links to. Every other entry with a name and a
 * finite duration is reported in seconds, at most MAX_ENTRIES of them.
 */
import { remoteParentFromTraceparent } from "@libo11y/web/internal";
import type { SpanContext } from "@opentelemetry/api";

/** The fields of a PerformanceServerTiming entry. Durations are milliseconds. */
export interface ServerTimingEntryLike {
  readonly name: string;
  readonly duration: number;
  readonly description: string;
}

/** The most Server-Timing entries one resource span reports. */
export const MAX_SERVER_TIMING_ENTRIES = 10;

export interface ServerTiming {
  /** The server span a traceparent entry names. */
  readonly remote?: SpanContext;
  readonly entries: readonly { readonly name: string; readonly seconds: number }[];
}

export function readServerTiming(entries: readonly ServerTimingEntryLike[]): ServerTiming {
  let remote: SpanContext | undefined;
  const out: { name: string; seconds: number }[] = [];
  for (const e of entries) {
    if (e.name === "traceparent") {
      remote ??= remoteParentFromTraceparent(e.description);
    } else if (e.name !== "" && Number.isFinite(e.duration) && out.length < MAX_SERVER_TIMING_ENTRIES) {
      out.push({ name: e.name, seconds: e.duration / 1000 });
    }
  }
  return { ...(remote === undefined ? {} : { remote }), entries: out };
}
