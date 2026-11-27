/**
 * The view summary accumulator (design D2, spec 1.3.0 o11y.rum.view.summary). conformance/rum-summary
 * holds the shared vectors.
 *
 * Rules. A tracked view emits on close, and on flush when it has never emitted (seq 0) or has a
 * nonzero count, unsent visible time or an unsent vital. Counts and time on view are deltas since
 * the view's previous summary; a zero count is omitted. A vital is accepted once per view and name
 * and is sent in the next summary of that view. A closed view stays tracked, for late vitals, until
 * ten newer views closed after it.
 */
import {
  ATTR_RUM_PLATFORM,
  ATTR_RUM_SUMMARY_SEQ,
  ATTR_RUM_SUMMARY_TIME_ON_VIEW,
  ATTR_RUM_VIEW_ID,
  ATTR_RUM_VIEW_KIND,
  ATTR_RUM_VIEW_NAME,
  type RUMPlatform,
} from "@libo11y/spec";
import { ATTR_SESSION_ID, summaryCountKey, summaryVitalKey } from "../attrs.ts";
import type { SummaryAccumulator, SummaryCountKey, SummaryView, VitalName } from "../contracts/summary.ts";

const MAX_CLOSED = 10;

export interface SummaryOptions {
  readonly platform: RUMPlatform;
  /** Emits one o11y.rum.view.summary record with these attributes. */
  readonly emit: (attrs: Record<string, string | number>) => void;
  /** performance.now(). */
  readonly now: () => number;
  /** Whether the page is visible now. */
  readonly visible: () => boolean;
  /** Optional attributes added to every summary: o11y.rum.connection.effective, o11y.rum.config.version. */
  readonly context?: () => Readonly<Record<string, string | number>>;
}

interface Tracked {
  view: SummaryView;
  seq: number;
  counts: Map<SummaryCountKey, number>;
  vitals: Map<VitalName, number>;
  readonly sent: Set<VitalName>;
  visibleMillis: number;
  /** performance.now() since which the open, visible view has been accumulating time. */
  resumedAt: number | undefined;
  open: boolean;
}

export function createSummaryAccumulator(opts: SummaryOptions): SummaryAccumulator {
  const tracked = new Map<string, Tracked>();
  let current: Tracked | undefined;

  const accrue = (t: Tracked): void => {
    if (t.resumedAt === undefined) return;
    const n = opts.now();
    t.visibleMillis += Math.max(0, n - t.resumedAt);
    t.resumedAt = n;
  };
  const pending = (t: Tracked): boolean =>
    t.seq === 0 || t.counts.size > 0 || t.vitals.size > 0 || t.visibleMillis > 0;
  const send = (t: Tracked): void => {
    accrue(t);
    if (!pending(t)) return;
    const attrs: Record<string, string | number> = {
      ...(opts.context?.() ?? {}),
      [ATTR_RUM_PLATFORM]: opts.platform,
      [ATTR_RUM_VIEW_ID]: t.view.id,
      [ATTR_RUM_VIEW_NAME]: t.view.name,
      [ATTR_RUM_VIEW_KIND]: t.view.kind,
      [ATTR_SESSION_ID]: t.view.sessionId,
      [ATTR_RUM_SUMMARY_SEQ]: t.seq,
      [ATTR_RUM_SUMMARY_TIME_ON_VIEW]: t.visibleMillis / 1000,
    };
    for (const [k, n] of t.counts) if (n !== 0) attrs[summaryCountKey(k)] = n;
    for (const [v, x] of t.vitals) {
      attrs[summaryVitalKey(v)] = x;
      t.sent.add(v);
    }
    t.seq += 1;
    t.counts = new Map();
    t.vitals = new Map();
    t.visibleMillis = 0;
    opts.emit(attrs);
  };
  const prune = (): void => {
    const closed = [...tracked.values()].filter((t) => !t.open);
    for (const t of closed.slice(0, Math.max(0, closed.length - MAX_CLOSED))) tracked.delete(t.view.id);
  };

  return {
    open(view) {
      const t: Tracked = {
        view,
        seq: 0,
        counts: new Map(),
        vitals: new Map(),
        sent: new Set(),
        visibleMillis: 0,
        resumedAt: opts.visible() ? opts.now() : undefined,
        open: true,
      };
      tracked.set(view.id, t);
      current = t;
    },
    close(viewId) {
      const t = tracked.get(viewId);
      if (t === undefined || !t.open) return;
      send(t);
      t.open = false;
      t.resumedAt = undefined;
      if (current === t) current = undefined;
      prune();
    },
    rename(viewId, name) {
      const t = tracked.get(viewId);
      if (t !== undefined) t.view = { ...t.view, name };
    },
    count(key, n = 1) {
      if (current === undefined) return;
      current.counts.set(key, (current.counts.get(key) ?? 0) + n);
    },
    vital(viewId, name, value) {
      const t = tracked.get(viewId);
      if (t === undefined || t.sent.has(name) || t.vitals.has(name)) return;
      t.vitals.set(name, value);
    },
    visibility(visible) {
      if (current === undefined) return;
      if (visible) current.resumedAt ??= opts.now();
      else {
        accrue(current);
        current.resumedAt = undefined;
      }
    },
    flush() {
      for (const t of tracked.values()) send(t);
      prune();
    },
    reset() {
      tracked.clear();
      current = undefined;
    },
  };
}
