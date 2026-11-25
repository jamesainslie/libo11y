/**
 * WP2 (queue and consent). The IndexedDB PersistentQueue.
 *
 * Database opts.databaseName (default "libo11y"), version 1, one object store "otlp-batches" with
 * keyPath "id" and an index "enqueuedAt". claim, put (with its evictions), reschedule, remove,
 * clear and releaseLeases each run in one readwrite transaction and resolve on its complete event, so concurrent
 * tabs and worker wakes never claim the same entry twice. A versionchange from another context
 * closes this connection; later calls reopen it once, then fall back to behaving as empty.
 */
import { diag } from "@opentelemetry/api";
import type {
  NewQueueEntry,
  PersistentQueue,
  QueueEntry,
  QueueOptions,
  QueueSize,
} from "../contracts/queue.ts";
import { type Bounds, buildEntry, dueAt, evictionPlan, isDue, isExpired, resolveBounds } from "./bounds.ts";
import { createMemoryQueue } from "./memory.ts";

/** The object store name. */
export const STORE_NAME = "otlp-batches";

const INDEX_NAME = "enqueuedAt";
const DEFAULT_DATABASE_NAME = "libo11y";
const SIGNALS: ReadonlySet<unknown> = new Set(["traces", "metrics", "logs"]);

// isEntry reports whether a stored row is a well-formed entry. Rows written by anything else are
// skipped, and removed where a transaction meets them.
function isEntry(row: unknown): row is QueueEntry {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    SIGNALS.has(r.signal) &&
    typeof r.body === "string" &&
    typeof r.bytes === "number" &&
    typeof r.enqueuedAt === "number" &&
    typeof r.attempts === "number" &&
    typeof r.notBefore === "number" &&
    typeof r.leaseUntil === "number"
  );
}

function rowId(row: unknown): IDBValidKey | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const id = (row as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function isQuotaError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "QuotaExceededError";
}

type Fail = (err: unknown) => void;

// guarded runs fn as an event handler that aborts the transaction through fail when it throws,
// keeping the original error rather than the abort's.
function guarded(fail: Fail, fn: () => void): () => void {
  return () => {
    try {
      fn();
    } catch (err) {
      fail(err);
    }
  };
}

// transact runs body in one transaction on the store and resolves with its result on complete.
// It rejects with the first error a handler threw or a request failed with, once aborted.
function transact<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore, fail: Fail) => () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, mode);
    } catch (err) {
      reject(err);
      return;
    }
    let failure: unknown;
    const fail: Fail = (err) => {
      failure ??= err;
      try {
        tx.abort();
      } catch {
        // Already finished or aborting.
      }
    };
    let result: () => T = () => undefined as T;
    tx.oncomplete = () => {
      try {
        resolve(result());
      } catch (err) {
        reject(err);
      }
    };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("libo11y: IndexedDB transaction aborted"));
    try {
      result = body(tx.objectStore(STORE_NAME), fail);
    } catch (err) {
      fail(err);
    }
  });
}

// openRequest opens name at version (the current version when undefined), creating the store
// and its index on upgrade. A success after a block already rejected is closed at once.
function openRequest(factory: IDBFactory, name: string, version?: number): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = version === undefined ? factory.open(name) : factory.open(name, version);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    req.onupgradeneeded = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" }).createIndex(INDEX_NAME, INDEX_NAME);
        }
      } catch (err) {
        settled = true;
        reject(err);
        req.transaction?.abort();
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      reject(req.error ?? new Error("libo11y: IndexedDB open failed"));
    };
    req.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("libo11y: IndexedDB open blocked by another connection"));
    };
  });
}

// openDatabase opens the current version, and upgrades by one when another context left the
// database without the store.
async function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const db = await openRequest(factory, name);
  if (db.objectStoreNames.contains(STORE_NAME)) return db;
  const next = db.version + 1;
  db.close();
  return openRequest(factory, name, next);
}

class IndexedDbQueue implements PersistentQueue {
  readonly kind = "indexeddb";
  private readonly factory: IDBFactory;
  private readonly name: string;
  private readonly bounds: Bounds;
  private readonly opts: QueueOptions;
  private db: IDBDatabase | undefined;
  private reopening: Promise<IDBDatabase | undefined> | undefined;
  // Set by close() or a failed reopen; every later call goes to it.
  private fallback: PersistentQueue | undefined;

  constructor(factory: IDBFactory, name: string, db: IDBDatabase, opts: QueueOptions) {
    this.factory = factory;
    this.name = name;
    this.opts = opts;
    this.bounds = resolveBounds(opts);
    this.attach(db);
  }

  private attach(db: IDBDatabase): void {
    this.db = db;
    db.onversionchange = () => {
      db.close();
      this.lost(db);
    };
    db.onclose = () => this.lost(db);
  }

  private lost(db: IDBDatabase): void {
    if (this.db === db) this.db = undefined;
  }

  private memory(): PersistentQueue {
    this.fallback ??= createMemoryQueue(this.opts);
    return this.fallback;
  }

  // connection returns the open database, reopening it after a versionchange or a forced close.
  // A failed reopen is reported and leaves the queue on its memory fallback for good.
  private connection(): Promise<IDBDatabase | undefined> {
    if (this.fallback !== undefined) return Promise.resolve(undefined);
    if (this.db !== undefined) return Promise.resolve(this.db);
    this.reopening ??= openDatabase(this.factory, this.name).then(
      (db) => {
        this.reopening = undefined;
        if (this.fallback !== undefined) {
          db.close();
          return undefined;
        }
        this.attach(db);
        return db;
      },
      (err: unknown) => {
        this.reopening = undefined;
        diag.warn("libo11y: reopening the IndexedDB queue failed; queueing in memory", err);
        this.memory();
        return undefined;
      },
    );
    return this.reopening;
  }

  // run does op on the database, or on the memory fallback; a storage failure is reported and
  // resolves as failed().
  private async run<T>(
    op: string,
    failed: T,
    onMemory: (q: PersistentQueue) => Promise<T>,
    onDb: (db: IDBDatabase) => Promise<T>,
  ): Promise<T> {
    const db = await this.connection();
    if (db === undefined) return onMemory(this.memory());
    try {
      return await onDb(db);
    } catch (err) {
      diag.error(`libo11y: IndexedDB queue ${op} failed`, err);
      return failed;
    }
  }

  put(batch: NewQueueEntry): Promise<QueueEntry | undefined> {
    return this.run(
      "put",
      undefined,
      (q) => q.put(batch),
      async (db) => {
        const now = this.bounds.now();
        const entry = buildEntry(batch, now);
        if (entry.bytes > this.bounds.maxBytes) return undefined;
        try {
          return await this.store(db, entry, now, false);
        } catch (err) {
          if (!isQuotaError(err)) throw err;
          return await this.store(db, entry, now, true);
        }
      },
    );
  }

  // store adds entry after the evictions put owes, in one transaction. extraQuarter also evicts
  // the oldest quarter of what remains, for the retry after a QuotaExceededError.
  private store(db: IDBDatabase, entry: QueueEntry, now: number, extraQuarter: boolean): Promise<QueueEntry> {
    return transact(db, "readwrite", (store, fail) => {
      const req = store.index(INDEX_NAME).getAll();
      req.onsuccess = guarded(fail, () => {
        const existing: QueueEntry[] = [];
        for (const row of req.result as unknown[]) {
          if (isEntry(row)) existing.push(row);
          else {
            const id = rowId(row);
            if (id !== undefined) store.delete(id);
          }
        }
        for (const id of evictionPlan(existing, entry, now, this.bounds, extraQuarter)) store.delete(id);
        store.add(entry);
      });
      return () => ({ ...entry });
    });
  }

  claim(now: number, limit: number, leaseMillis: number): Promise<readonly QueueEntry[]> {
    return this.run(
      "claim",
      [],
      (q) => q.claim(now, limit, leaseMillis),
      (db) => {
        if (limit <= 0) return Promise.resolve([]);
        return transact(db, "readwrite", (store, fail) => {
          const out: QueueEntry[] = [];
          const req = store.index(INDEX_NAME).openCursor();
          req.onsuccess = guarded(fail, () => {
            const cursor = req.result;
            if (cursor === null) return;
            const row: unknown = cursor.value;
            if (!isEntry(row) || isExpired(row, now, this.bounds)) {
              cursor.delete();
            } else if (isDue(row, now)) {
              const leased: QueueEntry = { ...row, leaseUntil: now + leaseMillis };
              cursor.update(leased);
              out.push(leased);
              // Expired entries are the oldest, so none is left behind past the limit.
              if (out.length >= limit) return;
            }
            cursor.continue();
          });
          return () => out;
        });
      },
    );
  }

  reschedule(id: string, notBefore: number): Promise<void> {
    return this.run(
      "reschedule",
      undefined,
      (q) => q.reschedule(id, notBefore),
      (db) =>
        transact(db, "readwrite", (store, fail) => {
          const req = store.get(id);
          req.onsuccess = guarded(fail, () => {
            const row: unknown = req.result;
            if (isEntry(row)) store.put({ ...row, attempts: row.attempts + 1, notBefore, leaseUntil: 0 });
          });
          return () => undefined;
        }),
    );
  }

  remove(ids: readonly string[]): Promise<void> {
    return this.run(
      "remove",
      undefined,
      (q) => q.remove(ids),
      (db) => {
        if (ids.length === 0) return Promise.resolve();
        return transact(db, "readwrite", (store) => {
          for (const id of ids) store.delete(id);
          return () => undefined;
        });
      },
    );
  }

  clear(): Promise<void> {
    return this.run(
      "clear",
      undefined,
      (q) => q.clear(),
      (db) =>
        transact(db, "readwrite", (store) => {
          store.clear();
          return () => undefined;
        }),
    );
  }

  releaseLeases(): Promise<void> {
    return this.run(
      "releaseLeases",
      undefined,
      (q) => q.releaseLeases(),
      (db) =>
        transact(db, "readwrite", (store, fail) => {
          const req = store.openCursor();
          req.onsuccess = guarded(fail, () => {
            const cursor = req.result;
            if (cursor === null) return;
            const row: unknown = cursor.value;
            if (isEntry(row) && row.leaseUntil !== 0) cursor.update({ ...row, leaseUntil: 0 });
            cursor.continue();
          });
          return () => undefined;
        }),
    );
  }

  // entries reads every well-formed entry in one readonly transaction.
  private entries(db: IDBDatabase): Promise<QueueEntry[]> {
    return transact(db, "readonly", (store) => {
      const req = store.getAll();
      return () => (req.result as unknown[]).filter(isEntry);
    });
  }

  nextDue(): Promise<number | undefined> {
    return this.run(
      "nextDue",
      undefined,
      (q) => q.nextDue(),
      async (db) => {
        let min: number | undefined;
        for (const e of await this.entries(db)) {
          const t = dueAt(e);
          if (min === undefined || t < min) min = t;
        }
        return min;
      },
    );
  }

  size(): Promise<QueueSize> {
    return this.run(
      "size",
      { entries: 0, bytes: 0 },
      (q) => q.size(),
      async (db) => {
        const all = await this.entries(db);
        return { entries: all.length, bytes: all.reduce((n, e) => n + e.bytes, 0) };
      },
    );
  }

  close(): void {
    this.memory();
    const db = this.db;
    this.db = undefined;
    try {
      db?.close();
    } catch {
      // Closing is best effort.
    }
  }
}

function globalFactory(): IDBFactory | undefined {
  return (globalThis as { indexedDB?: IDBFactory }).indexedDB;
}

/** Opens the IndexedDB queue. Rejects when IndexedDB is missing or the open fails or is blocked. */
export async function openIndexedDbQueue(opts: QueueOptions = {}): Promise<PersistentQueue> {
  // Reading globalThis.indexedDB throws a SecurityError in some sandboxed frames.
  const factory = opts.indexedDB ?? globalFactory();
  if (factory === undefined) throw new Error("libo11y: IndexedDB is not available");
  const name = opts.databaseName ?? DEFAULT_DATABASE_NAME;
  const db = await openDatabase(factory, name);
  return new IndexedDbQueue(factory, name, db, opts);
}
