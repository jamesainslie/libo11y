/**
 * WP2. The queue spec's page: the real queues over the browser's IndexedDB, driven through
 * globalThis.__queue. Entries cross page.evaluate as plain JSON.
 */
import type { NewQueueEntry, PersistentQueue, QueueEntry } from "../../src/contracts/queue.ts";
import { openIndexedDbQueue } from "../../src/queue/indexeddb.ts";
import { openQueue } from "../../src/queue/open.ts";

/** What the spec calls through page.evaluate. */
export interface QueuePage {
  /** Opens the queue through openQueue and reports its kind. */
  open(databaseName: string): Promise<PersistentQueue["kind"]>;
  /** Opens the IndexedDB queue directly, rejecting on failure. */
  openIndexedDb(databaseName: string): Promise<PersistentQueue["kind"]>;
  put(batch: NewQueueEntry): Promise<QueueEntry | undefined>;
  claim(limit: number, leaseMillis: number): Promise<readonly QueueEntry[]>;
  remove(ids: readonly string[]): Promise<void>;
  size(): Promise<{ entries: number; bytes: number }>;
  close(): void;
}

let queue: PersistentQueue | undefined;

function current(): PersistentQueue {
  if (queue === undefined) throw new Error("open the queue first");
  return queue;
}

const page: QueuePage = {
  async open(databaseName) {
    queue = await openQueue({ databaseName });
    return queue.kind;
  },
  async openIndexedDb(databaseName) {
    queue = await openIndexedDbQueue({ databaseName });
    return queue.kind;
  },
  put: (batch) => current().put(batch),
  claim: (limit, leaseMillis) => current().claim(Date.now(), limit, leaseMillis),
  remove: (ids) => current().remove(ids),
  size: () => current().size(),
  close: () => current().close(),
};

(globalThis as { __queue?: QueuePage }).__queue = page;
