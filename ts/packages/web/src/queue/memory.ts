/**
 * WP2 (queue and consent). The in-memory PersistentQueue: the fallback where IndexedDB is missing
 * or broken, and the content-script queue in webext. Same bounds and lease semantics as IndexedDB.
 */
import type { PersistentQueue, QueueOptions } from "../contracts/queue.ts";

/** A memory queue with kind "memory". It ignores databaseName and indexedDB. */
export function createMemoryQueue(opts?: QueueOptions): PersistentQueue {
  void opts;
  throw new Error("not implemented");
}
