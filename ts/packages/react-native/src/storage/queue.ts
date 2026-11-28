/**
 * The PersistentQueue over a KeyValueStorage, for React Native. One index key holds every entry's
 * metadata, and each body has a key of its own, read only when the entry is claimed, so the queue
 * holds no bodies in memory. A put resolves after the body and then the index are saved, so a batch
 * the delivery sends after its put survives a crash or a stop mid-send. Leases live in memory,
 * because one JavaScript context is the only consumer, and die with it. Bounds, eviction, expiry
 * and order are the web queues' (the shared bounds helpers and conformance suite).
 *
 * Opening reads only. Orphan bodies, left by a stop between a body and its index, are removed
 * inside the first mutating call, which the delivery makes only while consent is granted. An index
 * entry whose body is gone is dropped when claimed. Every method runs on one chain and never
 * rejects: a storage failure is reported through diag and the call resolves as if the change were
 * dropped. After close, calls behave as on an empty queue.
 */
import {
  buildEntry,
  byAge,
  dueAt,
  evictionPlan,
  isDue,
  isExpired,
  type NewQueueEntry,
  type PersistentQueue,
  type QueueEntry,
  type QueueOptions,
  type QueueSize,
  resolveBounds,
} from "@libo11y/web/portable";
import { diag } from "@opentelemetry/api";
import type { KeyValueStorage } from "../contracts/storage.ts";

/** Options for openStorageQueue: the web queue's bounds, and the storage. */
export interface StorageQueueOptions extends QueueOptions {
  readonly storage: KeyValueStorage;
}

/** What the index keeps of an entry: everything but the body and the lease. */
type Meta = Omit<QueueEntry, "body" | "leaseUntil">;

const INDEX_VERSION = 1;
const SIGNALS: ReadonlySet<unknown> = new Set(["traces", "metrics", "logs"]);

function isMeta(e: unknown): e is Meta {
  if (typeof e !== "object" || e === null) return false;
  const m = e as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    SIGNALS.has(m.signal) &&
    typeof m.bytes === "number" &&
    typeof m.enqueuedAt === "number" &&
    typeof m.attempts === "number" &&
    typeof m.notBefore === "number"
  );
}

/** The entries of a stored index; an index this version did not write, or cannot parse, is empty. */
function parseIndex(raw: string | null): Meta[] {
  if (raw === null) return [];
  try {
    const v = JSON.parse(raw) as { v?: unknown; entries?: unknown };
    return v.v === INDEX_VERSION && Array.isArray(v.entries) ? v.entries.filter(isMeta) : [];
  } catch {
    return [];
  }
}

/** Opens the queue under `libo11y/<databaseName>/` in storage (databaseName default "libo11y"). */
export async function openStorageQueue(opts: StorageQueueOptions): Promise<PersistentQueue> {
  const bounds = resolveBounds(opts);
  const { storage } = opts;
  const prefix = `libo11y/${opts.databaseName ?? "libo11y"}/`;
  const indexKey = `${prefix}index`;
  const bodyPrefix = `${prefix}b/`;
  // Every entry with an empty body: bodies stay in storage until claimed.
  const entries = new Map<string, QueueEntry>();
  try {
    for (const m of parseIndex(await storage.getItem(indexKey))) {
      entries.set(m.id, { ...m, body: "", leaseUntil: 0 });
    }
  } catch (err) {
    diag.warn("libo11y: react-native: reading the retry queue failed; it starts empty", err);
  }
  let closed = false;
  let cleaned = false;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fallback: T, fn: () => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      if (closed) return fallback;
      try {
        return await fn();
      } catch (err) {
        diag.warn("libo11y: react-native: a retry queue operation failed", err);
        return fallback;
      }
    };
    const p = chain.then(run, run);
    chain = p;
    return p;
  };
  const ordered = (): QueueEntry[] => [...entries.values()].sort(byAge);
  const writeIndex = (): Promise<void> =>
    storage.setItem(
      indexKey,
      JSON.stringify({
        v: INDEX_VERSION,
        entries: ordered().map(({ id, signal, bytes, enqueuedAt, attempts, notBefore }) => ({
          id,
          signal,
          bytes,
          enqueuedAt,
          attempts,
          notBefore,
        })),
      }),
    );
  // Removes the bodies no entry owns, once per queue (and again after clear).
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    for (const key of await storage.getAllKeys()) {
      if (key.startsWith(bodyPrefix) && !entries.has(key.slice(bodyPrefix.length))) {
        await storage.removeItem(key);
      }
    }
    cleaned = true;
  };
  const drop = async (ids: readonly string[]): Promise<void> => {
    for (const id of ids) {
      entries.delete(id);
      await storage.removeItem(bodyPrefix + id);
    }
  };

  return {
    kind: "storage",
    put: (batch: NewQueueEntry) =>
      serial<QueueEntry | undefined>(undefined, async () => {
        await cleanup();
        const now = bounds.now();
        const entry = buildEntry(batch, now);
        if (entry.bytes > bounds.maxBytes) return undefined;
        const evict = evictionPlan(ordered(), entry, now, bounds);
        await drop(evict);
        try {
          await storage.setItem(bodyPrefix + entry.id, entry.body);
          entries.set(entry.id, { ...entry, body: "" });
          await writeIndex();
        } catch (err) {
          // Not saved: keep nothing of it, so the caller's one direct attempt is the only send.
          entries.delete(entry.id);
          await storage.removeItem(bodyPrefix + entry.id).catch(() => {});
          throw err;
        }
        return entry;
      }),
    claim: (now: number, limit: number, leaseMillis: number) =>
      serial<readonly QueueEntry[]>([], async () => {
        await cleanup();
        const out: QueueEntry[] = [];
        const gone: string[] = [];
        for (const e of ordered()) {
          if (isExpired(e, now, bounds)) {
            gone.push(e.id);
            continue;
          }
          if (out.length >= limit) break;
          if (!isDue(e, now)) continue;
          const body = await storage.getItem(bodyPrefix + e.id);
          if (body === null) {
            gone.push(e.id);
            continue;
          }
          const leased = { ...e, leaseUntil: now + leaseMillis };
          entries.set(e.id, leased);
          out.push({ ...leased, body });
        }
        if (gone.length > 0) {
          await drop(gone);
          await writeIndex();
        }
        return out;
      }),
    reschedule: (id: string, notBefore: number) =>
      serial(undefined, async () => {
        const e = entries.get(id);
        if (e === undefined) return;
        entries.set(id, { ...e, attempts: e.attempts + 1, notBefore, leaseUntil: 0 });
        await writeIndex();
      }),
    remove: (ids: readonly string[]) =>
      serial(undefined, async () => {
        const known = ids.filter((id) => entries.has(id));
        if (known.length === 0) return;
        await drop(known);
        await writeIndex();
      }),
    clear: () =>
      serial(undefined, async () => {
        entries.clear();
        cleaned = false;
        await storage.removeItem(indexKey);
        await cleanup();
      }),
    releaseLeases: () =>
      serial(undefined, async () => {
        for (const [id, e] of entries) if (e.leaseUntil !== 0) entries.set(id, { ...e, leaseUntil: 0 });
      }),
    nextDue: () =>
      serial<number | undefined>(undefined, async () => {
        let next: number | undefined;
        for (const e of entries.values()) next = next === undefined ? dueAt(e) : Math.min(next, dueAt(e));
        return next;
      }),
    size: () =>
      serial<QueueSize>({ entries: 0, bytes: 0 }, async () => {
        let bytes = 0;
        for (const e of entries.values()) bytes += e.bytes;
        return { entries: entries.size, bytes };
      }),
    close() {
      closed = true;
      entries.clear();
    },
  };
}
