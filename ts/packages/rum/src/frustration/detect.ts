/**
 * Frustration signals.
 *
 * Rage: rageClicks or more clicks on the same element selector within rageWindowMillis, reported
 * once per burst, on the click that reaches the count. A burst ends when a click on that selector
 * comes more than the window after the previous one.
 *
 * Dead: an eligible click followed by no activity (a request, a DOM mutation or a view change)
 * within deadWindowMillis. The collector decides eligibility: form fields, labels, contenteditable
 * and clicks inside a text selection are not.
 *
 * Error: an error within errorWindowMillis of the last click, or while that click's action is
 * still open, reported once per click.
 */
import type { RUMFrustrationType } from "@libo11y/spec";
import type { SettleTimers } from "../actions/settle.ts";

export interface FrustrationDetectorOptions {
  /** Default 3. */
  readonly rageClicks?: number;
  /** Default 1000. */
  readonly rageWindowMillis?: number;
  /** Default 1000. */
  readonly deadWindowMillis?: number;
  /** Default 1000. */
  readonly errorWindowMillis?: number;
  readonly timers: SettleTimers;
  readonly onSignal: (type: RUMFrustrationType, selector: string, at: number) => void;
}

export interface FrustrationDetector {
  /** at is performance.now(). deadEligible is false for form fields, labels, contenteditable and clicks inside a selection. */
  click(selector: string, at: number, deadEligible: boolean): void;
  /** A request, mutation or view change. */
  activity(at: number): void;
  /** An error; actionOpen is true while the last click's action is still open. */
  error(at: number, actionOpen?: boolean): void;
  stop(): void;
}

interface Burst {
  times: number[];
  last: number;
  signalled: boolean;
}

export function createFrustrationDetector(o: FrustrationDetectorOptions): FrustrationDetector {
  const rageClicks = o.rageClicks ?? 3;
  const rageWindow = o.rageWindowMillis ?? 1000;
  const deadWindow = o.deadWindowMillis ?? 1000;
  const errorWindow = o.errorWindowMillis ?? 1000;
  const bursts = new Map<string, Burst>();
  const dead = new Map<unknown, { selector: string; at: number }>();
  let lastClick: { selector: string; at: number; errored: boolean } | undefined;

  const rage = (selector: string, at: number): void => {
    for (const [s, b] of bursts) if (at - b.last > rageWindow) bursts.delete(s);
    let b = bursts.get(selector);
    if (b === undefined) {
      b = { times: [], last: at, signalled: false };
      bursts.set(selector, b);
    }
    b.last = at;
    b.times = [...b.times.filter((t) => at - t <= rageWindow), at];
    if (!b.signalled && b.times.length >= rageClicks) {
      b.signalled = true;
      o.onSignal("rage", selector, at);
    }
  };

  return {
    click(selector, at, deadEligible) {
      lastClick = { selector, at, errored: false };
      rage(selector, at);
      if (!deadEligible) return;
      const h: unknown = o.timers.setTimeout(() => {
        dead.delete(h);
        o.onSignal("dead", selector, at);
      }, deadWindow);
      dead.set(h, { selector, at });
    },
    activity(at) {
      for (const [h, c] of dead) {
        if (at < c.at) continue;
        o.timers.clearTimeout(h);
        dead.delete(h);
      }
    },
    error(at, actionOpen = false) {
      const c = lastClick;
      if (c === undefined || c.errored || at < c.at) return;
      if (!actionOpen && at - c.at > errorWindow) return;
      c.errored = true;
      o.onSignal("error", c.selector, at);
    },
    stop() {
      for (const h of dead.keys()) o.timers.clearTimeout(h);
      dead.clear();
      bursts.clear();
      lastClick = undefined;
    },
  };
}
