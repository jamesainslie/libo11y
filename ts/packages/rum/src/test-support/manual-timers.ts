/** A manual clock with timers that run only when advanced. Tests only; never built. */

export interface ManualTimers {
  now(): number;
  readonly timers: {
    setTimeout(cb: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  /** Moves the clock forward by ms, running every timer that falls due, in order. */
  advance(ms: number): void;
  /** Timers not yet run. */
  pending(): number;
}

export function manualTimers(start = 0): ManualTimers {
  let t = start;
  let next = 0;
  const due: { at: number; cb: () => void; id: number }[] = [];
  return {
    now: () => t,
    timers: {
      setTimeout: (cb, ms) => {
        const id = ++next;
        due.push({ at: t + Math.max(0, ms), cb, id });
        return id;
      },
      clearTimeout: (h) => {
        const i = due.findIndex((d) => d.id === h);
        if (i >= 0) due.splice(i, 1);
      },
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        due.sort((a, b) => a.at - b.at || a.id - b.id);
        const d = due[0];
        if (d === undefined || d.at > end) break;
        due.shift();
        t = d.at;
        d.cb();
      }
      t = end;
    },
    pending: () => due.length,
  };
}
