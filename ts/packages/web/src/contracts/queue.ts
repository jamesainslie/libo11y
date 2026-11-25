/**
 * Contract, frozen by the L4 scaffold. Changing it needs the architect's sign-off.
 *
 * The persistent queue (WP2) that the delivery (WP1) uses for offline retry and the webext worker
 * (WP5) uses to persist every batch before it is sent. Every tab of an origin, and every wake of an
 * extension service worker, shares one IndexedDB queue, so entries are claimed with a lease before
 * they are sent: a second claimant skips a leased entry until the lease runs out, and a context that
 * dies mid-send loses nothing, because its lease simply expires.
 */
import type { OtlpBatch, OtlpSignal } from "./otlp.ts";

/** One stored batch. */
export interface QueueEntry {
  /** Unique within the queue, assigned by put. */
  readonly id: string;
  readonly signal: OtlpSignal;
  /** The OTLP JSON body, as OtlpBatch.body. */
  readonly body: string;
  /** The UTF-8 length of body, which the byte bound counts. */
  readonly bytes: number;
  /** When put stored the entry, in epoch milliseconds. */
  readonly enqueuedAt: number;
  /** Failed send attempts so far. */
  readonly attempts: number;
  /** The earliest time the entry may be claimed, in epoch milliseconds. */
  readonly notBefore: number;
  /** While in the future, the entry belongs to whoever claimed it, in epoch milliseconds. 0 when unleased. */
  readonly leaseUntil: number;
}

/** What put stores. */
export interface NewQueueEntry extends OtlpBatch {
  /** The earliest time the entry may be claimed. Default now. */
  readonly notBefore?: number;
  /**
   * Store the entry already leased to the caller for this long, so the caller can send it at once
   * without a second claimant racing it. The webext worker's persist-then-send path uses it.
   */
  readonly leaseMillis?: number;
}

/** The queue's size. */
export interface QueueSize {
  readonly entries: number;
  readonly bytes: number;
}

/**
 * A bounded queue of OTLP batches. Every method resolves after its change is durable (the IndexedDB
 * transaction completed) and never rejects: a storage failure is reported through the
 * OpenTelemetry diag logger, and the method resolves as if the queue were empty or the change were
 * dropped.
 */
export interface PersistentQueue {
  /** "indexeddb", or "memory" when IndexedDB is unavailable or failed to open. */
  readonly kind: "indexeddb" | "memory";
  /**
   * Stores a batch. Entries older than maxAgeMillis are dropped first, then the oldest entries
   * until the new one fits maxEntries and maxBytes. Resolves with the stored entry, or undefined
   * when the batch alone is larger than maxBytes and was not stored.
   */
  put(batch: NewQueueEntry): Promise<QueueEntry | undefined>;
  /**
   * Leases up to limit entries whose notBefore and leaseUntil are both at or before now, oldest
   * enqueuedAt first, setting leaseUntil to now + leaseMillis in the same transaction. Expired
   * entries (older than maxAgeMillis) are removed, never returned.
   */
  claim(now: number, limit: number, leaseMillis: number): Promise<readonly QueueEntry[]>;
  /** Records a failed attempt: attempts + 1, notBefore set, lease released. Unknown ids are ignored. */
  reschedule(id: string, notBefore: number): Promise<void>;
  /** Removes delivered or abandoned entries. Unknown ids are ignored. */
  remove(ids: readonly string[]): Promise<void>;
  /** Removes every entry, leased or not. Consent revocation calls it. */
  clear(): Promise<void>;
  /**
   * The earliest time any entry becomes claimable: the larger of its notBefore and leaseUntil,
   * minimized over entries. Undefined when the queue is empty.
   */
  nextDue(): Promise<number | undefined>;
  size(): Promise<QueueSize>;
  /** Closes the database connection. Later calls behave as on an empty memory queue. */
  close(): void;
}

/** Options for openQueue. */
export interface QueueOptions {
  /** The IndexedDB database name. Default "libo11y". The object store is always "otlp-batches". */
  readonly databaseName?: string;
  /** Default 5 MiB (5_242_880). */
  readonly maxBytes?: number;
  /** Default 1000. */
  readonly maxEntries?: number;
  /** Entries older than this are dropped. Default 86_400_000 (24 hours). */
  readonly maxAgeMillis?: number;
  /**
   * The IndexedDB factory. Default globalThis.indexedDB; absent or failing to open gives a memory
   * queue. Tests pass fake-indexeddb's IDBFactory.
   */
  readonly indexedDB?: IDBFactory;
  /** The clock, for tests. Default Date.now. */
  readonly now?: () => number;
}
