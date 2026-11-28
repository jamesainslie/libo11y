/**
 * The segment envelope: what one upload carries (design decisions P5 and P7). A segment is
 * self-contained, starting with a Meta event and a full snapshot, so a player can start at any
 * segment and a lost upload loses only its own time. The gateway (POST /_o11y/v1/replay) accepts
 * these fields and no others.
 */
import type { RrwebEvent } from "./scrub.ts";

/** A view current during the segment. at is epoch milliseconds. */
export interface SegmentView {
  readonly id: string;
  readonly name: string;
  readonly at: number;
  readonly trace_id?: string;
  readonly span_id?: string;
}

/** A request span started during the segment, so a player can jump from a moment to its trace. */
export interface SegmentRequest {
  readonly trace_id: string;
  readonly span_id: string;
  readonly at: number;
}

export interface SegmentEnvelope {
  readonly format: 1;
  /** One per tab and session: the segments of one recording continue one DOM. */
  readonly recording: string;
  /** Epoch milliseconds of the first event. */
  readonly start: number;
  /** Epoch milliseconds of the last event. */
  readonly end: number;
  readonly views: readonly SegmentView[];
  readonly requests: readonly SegmentRequest[];
  /** Scrubbed rrweb events, oldest first. */
  readonly events: readonly RrwebEvent[];
}
