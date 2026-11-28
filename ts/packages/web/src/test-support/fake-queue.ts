/**
 * A minimal unbounded PersistentQueue with the contract's lease semantics, for transport and
 * extension tests. Not the memory
 * queue: it has no bounds and no expiry. Tests only; never built.
 */
import type { NewQueueEntry, PersistentQueue, QueueEntry, QueueSize } from "../contracts/queue.ts";

/** A fake queue that also exposes its entries. */
export interface FakeQueue extends PersistentQueue {
  readonly entries: Map<string, QueueEntry>;
}

/** A fresh fake queue on the given clock (default Date.now). */
export function createFakeQueue(now: () => number = Date.now): FakeQueue {
  const entries = new Map<string, QueueEntry>();
  let seq = 0;
  const encoder = new TextEncoder();
  return {
    kind: "memory",
    entries,
    async put(batch: NewQueueEntry) {
      const t = now();
      const entry: QueueEntry = {
        id: `fake-${++seq}`,
        signal: batch.signal,
        body: batch.body,
        bytes: encoder.encode(batch.body).byteLength,
        enqueuedAt: t,
        attempts: 0,
        notBefore: batch.notBefore ?? t,
        leaseUntil: batch.leaseMillis === undefined ? 0 : t + batch.leaseMillis,
      };
      entries.set(entry.id, entry);
      return entry;
    },
    async claim(at: number, limit: number, leaseMillis: number) {
      const due = [...entries.values()]
        .filter((e) => e.notBefore <= at && e.leaseUntil <= at)
        .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
        .slice(0, limit)
        .map((e) => ({ ...e, leaseUntil: at + leaseMillis }));
      for (const e of due) entries.set(e.id, e);
      return due;
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
      for (const [id, e] of entries) entries.set(id, { ...e, leaseUntil: 0 });
    },
    async nextDue() {
      let min: number | undefined;
      for (const e of entries.values()) {
        const t = Math.max(e.notBefore, e.leaseUntil);
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
