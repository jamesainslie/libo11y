/**
 * WP2 (queue and consent). The IndexedDB PersistentQueue.
 *
 * Database opts.databaseName (default "libo11y"), version 1, one object store "otlp-batches" with
 * keyPath "id" and an index "enqueuedAt". claim, put (with its evictions), reschedule, remove and
 * clear each run in one readwrite transaction and resolve on its complete event, so concurrent
 * tabs and worker wakes never claim the same entry twice. A versionchange from another context
 * closes this connection; later calls reopen it once, then fall back to behaving as empty.
 */
import type { PersistentQueue, QueueOptions } from "../contracts/queue.ts";

/** The object store name. */
export const STORE_NAME = "otlp-batches";

/** Opens the IndexedDB queue. Rejects when IndexedDB is missing or the open fails or is blocked. */
export function openIndexedDbQueue(opts?: QueueOptions): Promise<PersistentQueue> {
  void opts;
  throw new Error("not implemented");
}
