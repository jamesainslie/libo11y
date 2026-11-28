/**
 * The action settle rule. An action ends at the time of its last activity (a
 * request end or a DOM mutation it caused, or its start), detected once no request is pending and
 * idleMillis passed without activity, capped capMillis after it started. Its duration therefore
 * excludes the idle wait. end() settles at once, as when a new action starts.
 */

export interface SettleTimers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SettleTracker {
  requestStarted(id: string, at: number): void;
  requestEnded(id: string, at: number): void;
  activity(at: number): void;
  /** Ends now, at the last activity: a new action started, or the collector stopped. */
  end(): void;
}

export interface SettleOptions {
  /** performance.now() when the action started. */
  readonly start: number;
  readonly idleMillis: number;
  readonly capMillis: number;
  readonly now: () => number;
  readonly timers: SettleTimers;
  /** Called once with the action's end time. */
  readonly onSettle: (endTime: number) => void;
}

export function createSettleTracker(o: SettleOptions): SettleTracker {
  const pending = new Set<string>();
  let last = o.start;
  let done = false;
  let idle: unknown;
  let cap: unknown;
  const finish = (end: number): void => {
    if (done) return;
    done = true;
    o.timers.clearTimeout(idle);
    o.timers.clearTimeout(cap);
    o.onSettle(end);
  };
  const arm = (): void => {
    o.timers.clearTimeout(idle);
    idle = undefined;
    if (pending.size > 0 || done) return;
    idle = o.timers.setTimeout(() => finish(last), Math.max(0, last + o.idleMillis - o.now()));
  };
  const capAt = o.start + o.capMillis;
  cap = o.timers.setTimeout(() => finish(Math.min(o.now(), capAt)), Math.max(0, capAt - o.now()));
  arm();
  return {
    requestStarted(id, at) {
      if (done) return;
      pending.add(id);
      last = Math.max(last, at);
      arm();
    },
    requestEnded(id, at) {
      if (done || !pending.delete(id)) return;
      last = Math.max(last, at);
      arm();
    },
    activity(at) {
      if (done) return;
      last = Math.max(last, at);
      arm();
    },
    end: () => finish(last),
  };
}
