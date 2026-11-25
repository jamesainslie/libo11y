/**
 * WP2 (queue and consent). Opens the best queue the runtime has.
 */
import { diag } from "@opentelemetry/api";
import type { PersistentQueue, QueueOptions } from "../contracts/queue.ts";
import { openIndexedDbQueue } from "./indexeddb.ts";
import { createMemoryQueue } from "./memory.ts";

/** How long openQueue waits for IndexedDB before it settles for memory. */
export const OPEN_TIMEOUT_MILLIS = 3000;

type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const timers = globalThis as unknown as Timers;

const TIMED_OUT: unique symbol = Symbol("timed out");

// hasFactory reports whether opts or the global offer an IndexedDB factory. Reading the global
// throws in some sandboxed frames, which counts as none.
function hasFactory(opts: QueueOptions): boolean {
  if (opts.indexedDB !== undefined) return true;
  try {
    return (globalThis as { indexedDB?: IDBFactory }).indexedDB !== undefined;
  } catch {
    return false;
  }
}

/**
 * The IndexedDB queue, or a memory queue when IndexedDB is missing or fails to open within
 * 3 seconds (reported through diag). Never rejects.
 */
export function openQueue(opts?: QueueOptions): Promise<PersistentQueue> {
  return openQueueWithin(opts, OPEN_TIMEOUT_MILLIS);
}

/**
 * openQueue with the timeout given in milliseconds, for tests. An open that succeeds after the
 * timeout is closed again, so the late connection never blocks another context's upgrade.
 */
export async function openQueueWithin(
  opts: QueueOptions = {},
  timeoutMillis: number,
): Promise<PersistentQueue> {
  if (!hasFactory(opts)) {
    diag.debug("libo11y: IndexedDB is not available; queueing in memory");
    return createMemoryQueue(opts);
  }
  const opening = openIndexedDbQueue(opts);
  let handle: unknown;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    handle = timers.setTimeout(() => resolve(TIMED_OUT), timeoutMillis);
  });
  try {
    const outcome = await Promise.race([opening, timeout]);
    if (outcome !== TIMED_OUT) return outcome;
    diag.warn(`libo11y: IndexedDB did not open within ${timeoutMillis} ms; queueing in memory`);
    opening.then(
      (late) => late.close(),
      () => {},
    );
  } catch (err) {
    diag.warn("libo11y: IndexedDB failed to open; queueing in memory", err);
  } finally {
    timers.clearTimeout(handle);
  }
  return createMemoryQueue(opts);
}
