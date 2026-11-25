/**
 * WP2 (queue and consent). Opens the best queue the runtime has.
 */
import type { PersistentQueue, QueueOptions } from "../contracts/queue.ts";

/**
 * The IndexedDB queue, or a memory queue when IndexedDB is missing or fails to open within
 * 3 seconds (reported through diag). Never rejects.
 */
export function openQueue(opts?: QueueOptions): Promise<PersistentQueue> {
  void opts;
  throw new Error("not implemented");
}
