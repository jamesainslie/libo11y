/**
 * The timer functions. They exist in every runtime core targets, but the ES library types do not
 * declare them, and core takes nothing else from the runtime.
 */

type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const timers = globalThis as unknown as Timers;

/** The longest delay a timer takes: setTimeout treats anything larger as 1 ms. */
export const MAX_TIMEOUT_MILLIS: number = 2 ** 31 - 1;

/**
 * Calls fn after ms, and returns what cancels it. The timer is unref'd where the runtime allows, so
 * it never holds the process open. A timer that cannot be armed throws here, to the caller.
 */
export function after(ms: number, fn: () => void): () => void {
  const handle = timers.setTimeout(fn, Math.min(Math.max(ms, 0), MAX_TIMEOUT_MILLIS));
  (handle as { unref?: () => void } | undefined)?.unref?.();
  return () => timers.clearTimeout(handle);
}

/**
 * Resolves on the next turn of the event loop, after every microtask already queued has run. Its
 * timer is not unref'd: a caller awaits it, and an unref'd timer would let the process end with
 * that caller still waiting.
 */
export function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    timers.setTimeout(resolve, 0);
  });
}
