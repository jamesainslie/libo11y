/**
 * longAnimationFrames(): counts long-animation-frame entries into the current view's
 * o11y.rum.summary.long_animation_frames. The first start observes buffered entries, so frames from
 * before it count toward the load view; a restart (consent granted again) counts only new ones.
 * Engines without the entry type (Firefox and WebKit today) record nothing. There is no long-task
 * fallback, because the spec counts long animation frames and a long task is a different measure,
 * so the gateway's o11y.rum.browser.long_animation_frames reflects Chromium-family browsers only.
 */
import type { RumCollector } from "./contracts/runtime.ts";

/** Observes long animation frames, calling cb with the number in each batch. Returns the function that stops. */
export type LongAnimationFrameSource = (cb: (count: number) => void, buffered: boolean) => () => void;

/** For tests: the collector over an injected source. */
export function longAnimationFramesWith(observe: LongAnimationFrameSource): RumCollector {
  let starts = 0;
  return {
    name: "long_animation_frames",
    start(rt) {
      starts++;
      return observe((n) => {
        if (n > 0 && rt.gate.recording()) rt.summary.count("long_animation_frames", n);
      }, starts === 1);
    },
  };
}

const browserSource: LongAnimationFrameSource = (cb, buffered) => {
  if (
    typeof PerformanceObserver === "undefined" ||
    !(PerformanceObserver.supportedEntryTypes ?? []).includes("long-animation-frame")
  ) {
    return () => {};
  }
  const observer = new PerformanceObserver((list) => cb(list.getEntries().length));
  observer.observe({ type: "long-animation-frame", buffered });
  return () => observer.disconnect();
};

/** Counts long animation frames per view, on engines that report them. */
export function longAnimationFrames(): RumCollector {
  return longAnimationFramesWith(browserSource);
}
