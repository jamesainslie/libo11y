/**
 * The retention buffer (design, "What a client sends", item 4): detail of a session not yet kept,
 * in its own IndexedDB queue so a reload keeps it and every tab of the session shares it. Flushing
 * claims a few entries at a time with a lease and removes each one once it is handed over, so two
 * tabs that both see the session become kept send each batch once. Where IndexedDB is unavailable,
 * openQueue gives a memory queue and a reload loses it. The queue is opened on first use, so a
 * caller that uses it only after consent creates no database before consent.
 */
import type { Delivery, OtlpBatch, PersistentQueue } from "@libo11y/web/portable";
import { diag } from "@opentelemetry/api";
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

/** Entries claimed per round. */
const CLAIM_BATCH = 5;
/** The lease covers a round of sends at the longest send time, plus a margin. */
const LEASE_MARGIN_MILLIS = 30_000;
const DEFAULT_SEND_TIMEOUT_MILLIS = 10_000;

export interface RetentionBufferOptions {
  readonly open: () => Promise<PersistentQueue>;
  /** Epoch milliseconds. Default Date.now. */
  readonly now?: () => number;
  /** The longest one send can take, the transport timeout. Default 10000. Sets the claim lease. */
  readonly sendTimeoutMillis?: number;
}

export function createRetentionBuffer(opts: RetentionBufferOptions): RetentionBuffer {
  const now = opts.now ?? Date.now;
  const lease = CLAIM_BATCH * (opts.sendTimeoutMillis ?? DEFAULT_SEND_TIMEOUT_MILLIS) + LEASE_MARGIN_MILLIS;
  let opening: Promise<PersistentQueue | undefined> | undefined;
  let closed = false;
  const queue = (): Promise<PersistentQueue | undefined> => {
    opening ??= opts.open().catch((err: unknown) => {
      diag.warn("o11y: rum: the retention buffer could not open", err);
      return undefined;
    });
    return opening;
  };
  return {
    async put(batch) {
      if (closed) return;
      try {
        await (await queue())?.put(batch);
      } catch (err) {
        diag.warn("o11y: rum: a retention buffer write failed", err);
      }
    },
    async flush(delivery: Delivery, keep?: (batch: OtlpBatch) => boolean) {
      if (closed) return 0;
      let sent = 0;
      try {
        const q = await queue();
        if (q === undefined) return 0;
        for (;;) {
          const entries = await q.claim(now(), CLAIM_BATCH, lease);
          if (entries.length === 0) return sent;
          for (const e of entries) {
            const batch: OtlpBatch = { signal: e.signal, body: e.body };
            // The delivery keeps a retryable failure in its own retry queue, so the entry is done here.
            if (keep === undefined || keep(batch)) {
              await delivery.deliver(batch);
              sent++;
            }
            await q.remove([e.id]);
          }
        }
      } catch (err) {
        diag.warn("o11y: rum: the retention flush failed", err);
        return sent;
      }
    },
    async discard(match) {
      if (closed) return 0;
      try {
        const q = await queue();
        if (q === undefined) return 0;
        // A zero lease leaves every entry this claim reads claimable by other contexts at once.
        const entries = await q.claim(now(), RETENTION_QUEUE_DEFAULTS.maxEntries, 0);
        const ids = entries.filter((e) => match({ signal: e.signal, body: e.body })).map((e) => e.id);
        if (ids.length > 0) await q.remove(ids);
        return ids.length;
      } catch (err) {
        diag.warn("o11y: rum: discarding from the retention buffer failed", err);
        return 0;
      }
    },
    async clear() {
      if (closed) return;
      try {
        // Opens the queue if needed: a previous page of the session may have left entries.
        await (await queue())?.clear();
      } catch (err) {
        diag.warn("o11y: rum: clearing the retention buffer failed", err);
      }
    },
    async size() {
      const q = opening === undefined ? undefined : await opening;
      return q === undefined ? { entries: 0, bytes: 0 } : q.size();
    },
    close() {
      closed = true;
      void opening?.then((q) => q?.close());
    },
  };
}
