/**
 * The retention buffer (design, "What a client sends", item 4): detail of a session not yet kept,
 * in its own IndexedDB queue so a reload keeps it and every tab of the session shares it. Flushing
 * claims entries with a lease, so two tabs that both see the session become kept send each batch
 * once. Where IndexedDB is unavailable, openQueue gives a memory queue and a reload loses it. The
 * queue is opened on first use, which is always after consent was granted, so no database is
 * created before consent.
 */
import type { Delivery, PersistentQueue } from "@libo11y/web/internal";
import type { RetentionBuffer } from "../contracts/retention.ts";

/** The retention queue's database and bounds. setupRum's rum.retention overrides the bounds. */
export const RETENTION_QUEUE_DEFAULTS: {
  readonly databaseName: "libo11y-rum-retention";
  readonly maxBytes: 2_097_152;
  readonly maxAgeMillis: 900_000;
  readonly maxEntries: 1000;
} = {
  databaseName: "libo11y-rum-retention",
  maxBytes: 2_097_152,
  maxAgeMillis: 900_000,
  maxEntries: 1000,
};

const CLAIM_BATCH = 20;
const LEASE_MILLIS = 30_000;

export interface RetentionBufferOptions {
  readonly open: () => Promise<PersistentQueue>;
  /** Epoch milliseconds. Default Date.now. */
  readonly now?: () => number;
}

export function createRetentionBuffer(opts: RetentionBufferOptions): RetentionBuffer {
  const now = opts.now ?? Date.now;
  let opening: Promise<PersistentQueue> | undefined;
  let closed = false;
  const queue = (): Promise<PersistentQueue> => {
    opening ??= opts.open();
    return opening;
  };
  return {
    async put(batch) {
      if (!closed) await (await queue()).put(batch);
    },
    async flush(delivery: Delivery) {
      if (closed) return 0;
      const q = await queue();
      let sent = 0;
      for (;;) {
        const entries = await q.claim(now(), CLAIM_BATCH, LEASE_MILLIS);
        if (entries.length === 0) return sent;
        for (const e of entries) {
          // The delivery keeps a retryable failure in its own retry queue, so the entry is done here.
          await delivery.deliver({ signal: e.signal, body: e.body });
          sent++;
        }
        await q.remove(entries.map((e) => e.id));
      }
    },
    async clear() {
      // Opens the queue if needed: a previous page of the session may have left entries.
      if (!closed) await (await queue()).clear();
    },
    async size() {
      return opening === undefined ? { entries: 0, bytes: 0 } : (await opening).size();
    },
    close() {
      closed = true;
      void opening?.then((q) => q.close());
    },
  };
}
