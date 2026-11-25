/**
 * WP2 (queue and consent). The in-memory PersistentQueue: the fallback where IndexedDB is missing
 * or broken, and the content-script queue in webext. Same bounds and lease semantics as IndexedDB.
 */
import type {
  NewQueueEntry,
  PersistentQueue,
  QueueEntry,
  QueueOptions,
  QueueSize,
} from "../contracts/queue.ts";
import { buildEntry, byAge, dueAt, evictionPlan, isDue, isExpired, resolveBounds } from "./bounds.ts";

/** A memory queue with kind "memory". It ignores databaseName and indexedDB. */
export function createMemoryQueue(opts?: QueueOptions): PersistentQueue {
  const bounds = resolveBounds(opts);
  // Insertion order is put order; ordered() sorts by age in case the clock stepped back.
  const entries = new Map<string, QueueEntry>();
  const ordered = (): QueueEntry[] => [...entries.values()].sort(byAge);

  return {
    kind: "memory",
    async put(batch: NewQueueEntry) {
      const now = bounds.now();
      const entry = buildEntry(batch, now);
      if (entry.bytes > bounds.maxBytes) return undefined;
      for (const id of evictionPlan(ordered(), entry, now, bounds)) entries.delete(id);
      entries.set(entry.id, entry);
      return { ...entry };
    },
    async claim(now: number, limit: number, leaseMillis: number) {
      const out: QueueEntry[] = [];
      for (const e of ordered()) {
        if (isExpired(e, now, bounds)) {
          entries.delete(e.id);
          continue;
        }
        if (out.length >= limit) break;
        if (!isDue(e, now)) continue;
        const leased = { ...e, leaseUntil: now + leaseMillis };
        entries.set(e.id, leased);
        out.push({ ...leased });
      }
      return out;
    },
    async reschedule(id: string, notBefore: number) {
      const e = entries.get(id);
      if (e !== undefined) entries.set(id, { ...e, attempts: e.attempts + 1, notBefore, leaseUntil: 0 });
    },
    async remove(ids: readonly string[]) {
      for (const id of ids) entries.delete(id);
    },
    async clear() {
      entries.clear();
    },
    async releaseLeases() {
      for (const [id, e] of entries) if (e.leaseUntil !== 0) entries.set(id, { ...e, leaseUntil: 0 });
    },
    async nextDue() {
      let min: number | undefined;
      for (const e of entries.values()) {
        const t = dueAt(e);
        if (min === undefined || t < min) min = t;
      }
      return min;
    },
    async size(): Promise<QueueSize> {
      let bytes = 0;
      for (const e of entries.values()) bytes += e.bytes;
      return { entries: entries.size, bytes };
    },
    close() {
      entries.clear();
    },
  };
}
