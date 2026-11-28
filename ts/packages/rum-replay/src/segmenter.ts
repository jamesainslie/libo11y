/**
 * Cuts the scrubbed event stream into self-contained segments (design decision P5).
 *
 * - A segment opens with a Meta event (type 4), which rrweb emits before every full snapshot. A
 *   Meta event while a segment is open closes it and opens the next, so every segment starts with
 *   Meta and a full snapshot.
 * - It closes maxMillis after it opened, once maxBytes of serialized events follow its opening
 *   snapshot (so a page whose snapshot alone is large does not cut a segment per event), at
 *   maxEvents events, and on cut (hide, session change, stop).
 * - After a close the segmenter takes no snapshot of its own, so an idle page costs nothing. The
 *   next event asks for one through checkout, on a timer, never inside the recorder's emit. While
 *   that checkout is pending, mutations are dropped, since the snapshot holds their result, and
 *   other events wait and follow the snapshot. A cut drops a pending checkout and what waits.
 * - A closed segment is passed to onClose when it holds an incremental event (type 3) or is the
 *   recording's first.
 * - views lists the view current when the segment opened and each view started while it was open,
 *   at most MAX_VIEWS. A view with an ID already listed replaces it (a rename, a span context). requests keeps the first maxRequests request spans started while it was open.
 */
import type { SegmentEnvelope, SegmentRequest, SegmentView } from "./envelope.ts";
import type { RrwebEvent } from "./scrub.ts";

/** At most this many views per segment, as the gateway accepts. */
export const MAX_VIEWS = 200;
/** At most this many events wait for a pending checkout. */
const MAX_WAITING = 1000;

export interface ClosedSegment {
  readonly envelope: SegmentEnvelope;
  /** True when it is the recording's first segment. */
  readonly first: boolean;
}

export interface Segmenter {
  push(e: RrwebEvent): void;
  view(v: SegmentView): void;
  request(r: SegmentRequest): void;
  /** Closes the open segment (hide, session change, stop) and drops a pending checkout. */
  cut(reason: "hide" | "session" | "stop"): void;
  /** The open segment's events so far, for tests. */
  openEvents(): number;
}

export interface SegmenterOptions {
  readonly recording: string;
  readonly maxMillis: number;
  readonly maxBytes: number;
  readonly maxEvents: number;
  readonly maxRequests: number;
  readonly timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  /** Asks the recorder for a full snapshot; it arrives through push. */
  readonly checkout: () => void;
  readonly onClose: (s: ClosedSegment) => void;
}

interface Open {
  readonly events: RrwebEvent[];
  readonly views: SegmentView[];
  readonly requests: SegmentRequest[];
  /** Bytes of the events after the opening snapshot. */
  bytes: number;
  snapshotDone: boolean;
  incremental: boolean;
  readonly timer: unknown;
}

const isMutation = (e: RrwebEvent): boolean =>
  e.type === 3 && (e.data as { source?: unknown } | undefined)?.source === 0;

export function createSegmenter(o: SegmenterOptions): Segmenter {
  let open: Open | undefined;
  let first = true;
  let current: SegmentView | undefined;
  /** The pending checkout's timer, and what waits for it. */
  let pending: unknown;
  let waiting: RrwebEvent[] = [];

  const close = (): void => {
    const s = open;
    if (s === undefined) return;
    open = undefined;
    o.timers.clearTimeout(s.timer);
    const isFirst = first;
    first = false;
    if (!s.incremental && !isFirst) return;
    const events = s.events;
    o.onClose({
      first: isFirst,
      envelope: {
        format: 1,
        recording: o.recording,
        start: events[0]?.timestamp ?? 0,
        end: events[events.length - 1]?.timestamp ?? 0,
        views: s.views,
        requests: s.requests,
        events,
      },
    });
  };

  const append = (e: RrwebEvent): void => {
    const s = open;
    if (s === undefined) return;
    s.events.push(e);
    if (e.type === 2) s.snapshotDone = true;
    else if (s.snapshotDone) s.bytes += JSON.stringify(e).length;
    if (e.type === 3) s.incremental = true;
    if (s.bytes >= o.maxBytes || s.events.length >= o.maxEvents) close();
  };

  const dropPending = (): void => {
    if (pending !== undefined) o.timers.clearTimeout(pending);
    pending = undefined;
    waiting = [];
  };

  const requestCheckout = (): void => {
    if (pending !== undefined) return;
    pending = o.timers.setTimeout(() => {
      pending = undefined;
      o.checkout();
      const held = waiting;
      waiting = [];
      for (const e of held) if (open !== undefined) append(e);
    }, 0);
  };

  return {
    push(e) {
      if (e.type === 4) {
        close();
        open = {
          events: [],
          views: current === undefined ? [] : [current],
          requests: [],
          bytes: 0,
          snapshotDone: false,
          incremental: false,
          timer: o.timers.setTimeout(close, o.maxMillis),
        };
        append(e);
        return;
      }
      if (open !== undefined) {
        append(e);
        return;
      }
      requestCheckout();
      if (!isMutation(e) && e.type !== 2 && waiting.length < MAX_WAITING) waiting.push(e);
    },
    view(v) {
      current = v;
      if (open === undefined) return;
      const i = open.views.findIndex((x) => x.id === v.id);
      if (i >= 0) open.views[i] = v;
      else if (open.views.length < MAX_VIEWS) open.views.push(v);
    },
    request(r) {
      if (open !== undefined && open.requests.length < o.maxRequests) open.requests.push(r);
    },
    cut() {
      dropPending();
      close();
    },
    openEvents: () => open?.events.length ?? 0,
  };
}
