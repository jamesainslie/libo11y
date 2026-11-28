/** The first paint after now, for view spans that end when the routed view is on screen. */

export interface PaintHost {
  requestAnimationFrame?(cb: () => void): number;
  setTimeout(cb: () => void, ms: number): unknown;
  readonly hidden: () => boolean;
}

/**
 * Calls cb with now() at the first paint after now: rendering follows the next animation frame,
 * so a task queued in that frame runs after the paint. A hidden page renders no frames, so it
 * waits for a task only.
 */
export function afterNextPaint(host: PaintHost, now: () => number, cb: (at: number) => void): void {
  const task = (): void => {
    host.setTimeout(() => cb(now()), 0);
  };
  if (host.hidden() || host.requestAnimationFrame === undefined) task();
  else host.requestAnimationFrame(task);
}
