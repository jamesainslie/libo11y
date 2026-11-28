/**
 * What the memory and IndexedDB queues share: the resolved bounds, entry
 * ids, and the eviction plan put follows, so both queues bound, expire and order alike.
 */
import type { NewQueueEntry, QueueEntry, QueueOptions } from "../contracts/queue.ts";
import { randomUuid } from "../ids.ts";

/** The default byte bound, 5 MiB. */
export const DEFAULT_MAX_BYTES = 5_242_880;
/** The default entry bound. */
export const DEFAULT_MAX_ENTRIES = 1000;
/** The default age bound, 24 hours. */
export const DEFAULT_MAX_AGE_MILLIS = 86_400_000;

/** The queue bounds with defaults applied. */
export interface Bounds {
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly maxAgeMillis: number;
  readonly now: () => number;
}

/** Applies the defaults to opts. */
export function resolveBounds(opts: QueueOptions = {}): Bounds {
  return {
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    maxEntries: opts.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxAgeMillis: opts.maxAgeMillis ?? DEFAULT_MAX_AGE_MILLIS,
    now: opts.now ?? Date.now,
  };
}

const encoder = new TextEncoder();

/** The UTF-8 length of body. */
export function utf8Length(body: string): number {
  return encoder.encode(body).byteLength;
}

/** True when entry is older than maxAgeMillis at now. */
export function isExpired(entry: Pick<QueueEntry, "enqueuedAt">, now: number, bounds: Bounds): boolean {
  return now - entry.enqueuedAt > bounds.maxAgeMillis;
}

/** True when entry may be claimed at now. */
export function isDue(entry: Pick<QueueEntry, "notBefore" | "leaseUntil">, now: number): boolean {
  return entry.notBefore <= now && entry.leaseUntil <= now;
}

/** When entry becomes claimable. */
export function dueAt(entry: Pick<QueueEntry, "notBefore" | "leaseUntil">): number {
  return Math.max(entry.notBefore, entry.leaseUntil);
}

let seq = 0;

/** 12 random hex digits: the first 12 of a random v4 UUID, before its version digit. */
function randomSuffix(): string {
  return randomUuid().replace("-", "").slice(0, 12);
}

/**
 * A fresh entry id. Ids sort by time, then by creation order within this context, so entries of
 * one millisecond keep their put order in the IndexedDB enqueuedAt index, whose ties are ordered
 * by id. The random suffix keeps ids of different tabs and wakes apart.
 */
export function newEntryId(now: number): string {
  seq = (seq + 1) % 2_176_782_336;
  return `${Math.max(0, Math.trunc(now)).toString(36).padStart(9, "0")}-${seq.toString(36).padStart(6, "0")}-${randomSuffix()}`;
}

/** The entry put stores for batch at now. */
export function buildEntry(batch: NewQueueEntry, now: number): QueueEntry {
  return {
    id: newEntryId(now),
    signal: batch.signal,
    body: batch.body,
    bytes: utf8Length(batch.body),
    enqueuedAt: now,
    attempts: 0,
    notBefore: batch.notBefore ?? now,
    leaseUntil: batch.leaseMillis === undefined ? 0 : now + batch.leaseMillis,
  };
}

/**
 * The ids put evicts before storing incoming: every expired entry, then the oldest until incoming
 * fits maxEntries and maxBytes. existing is ordered oldest first. With extraQuarter, it also evicts
 * the oldest quarter of what would remain, as the retry after a QuotaExceededError does.
 */
export function evictionPlan(
  existing: readonly QueueEntry[],
  incoming: QueueEntry,
  now: number,
  bounds: Bounds,
  extraQuarter = false,
): string[] {
  const evict: string[] = [];
  const kept: QueueEntry[] = [];
  for (const e of existing) {
    if (isExpired(e, now, bounds)) evict.push(e.id);
    else kept.push(e);
  }
  let bytes = kept.reduce((n, e) => n + e.bytes, 0);
  let i = 0;
  while (
    i < kept.length &&
    (kept.length - i + 1 > bounds.maxEntries || bytes + incoming.bytes > bounds.maxBytes)
  ) {
    const e = kept[i] as QueueEntry;
    evict.push(e.id);
    bytes -= e.bytes;
    i++;
  }
  if (extraQuarter) {
    const quarter = Math.ceil((kept.length - i) / 4);
    for (let j = 0; j < quarter; j++) evict.push((kept[i + j] as QueueEntry).id);
  }
  return evict;
}

/** Orders entries oldest enqueuedAt first, ties by id. */
export function byAge(a: QueueEntry, b: QueueEntry): number {
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
