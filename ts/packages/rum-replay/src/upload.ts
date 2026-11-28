/**
 * Compression and upload of closed segments. Each segment is gzipped with
 * CompressionStream and posted to the gateway's POST /_o11y/v1/replay as
 * ?service=&session=&segment=&sent_at=&client_token= (the client token only when the app has one,
 * sent_at taken per attempt so the gateway can correct clock skew), with credentials omitted and
 * keepalive while the body fits the browser's keepalive quota.
 *
 * - One request at a time, in queue order. The segment number is allocated just before the first
 *   attempt and kept for its retries, so a segment that never uploads takes no number.
 * - Before each segment goes out, allowed(session) must hold (consent granted and the session
 *   kept); a segment that may not upload is dropped.
 * - 2xx is done. 429 and 503 retry after Retry-After (seconds or an HTTP date; default 5 s, at
 *   most 60 s), and a network error after 5 s, for at most MAX_ATTEMPTS attempts. Anything else
 *   drops the segment.
 * - The queue, the segment in flight included, holds at most maxQueue segments and maxQueueBytes
 *   of compressed bodies; past either bound the oldest segment not in flight is dropped.
 */

/** The keepalive quota is 64 KiB for every keepalive request of a page; this leaves room for the rest. */
export const KEEPALIVE_MAX_BYTES = 61440;
/** Attempts per segment, the first included. */
export const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_MILLIS = 5000;
const MAX_RETRY_MILLIS = 60_000;

/** value as JSON, gzip-compressed with CompressionStream. */
export async function gzipJson(value: unknown): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface Uploader {
  /** Queues the segment of sessionId; it is compressed, numbered and sent in order. */
  enqueue(sessionId: string, envelope: unknown): void;
  /** Drops everything queued and forgets the segment numbers (revoke, stop). */
  clear(): void;
  /** The number of the segment of sessionId being sent or last sent, for error events. */
  currentSegment(sessionId: string): number | undefined;
}

export interface UploaderOptions {
  readonly url: string;
  readonly service: string;
  readonly clientToken?: string;
  readonly fetch: typeof fetch;
  readonly allocate: (sessionId: string) => Promise<number>;
  /** Epoch milliseconds, for sent_at. */
  readonly now: () => number;
  /** Whether a segment of sessionId may go out now: consent granted and the session kept. */
  readonly allowed: (sessionId: string) => boolean;
  readonly timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  readonly maxQueue: number;
  readonly maxQueueBytes: number;
}

interface Item {
  readonly sessionId: string;
  readonly body: Uint8Array;
  segment?: number;
  attempts: number;
}

/** The wait a Retry-After header asks for, in milliseconds. */
function retryAfter(header: string | null, now: number): number {
  if (header === null || header.trim() === "") return DEFAULT_RETRY_MILLIS;
  const seconds = Number(header);
  let ms = DEFAULT_RETRY_MILLIS;
  if (Number.isFinite(seconds) && seconds >= 0) ms = seconds * 1000;
  else {
    const at = Date.parse(header);
    if (Number.isFinite(at)) ms = at - now;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_MILLIS);
}

export function createUploader(o: UploaderOptions): Uploader {
  let pending: Item[] = [];
  let active: Item | undefined;
  let retryTimer: unknown;
  /** Bumped by clear, so work that started before it does nothing after. */
  let generation = 0;
  /** Compression keeps queue order: each segment is queued after the one before it. */
  let compressing: Promise<void> = Promise.resolve();
  let last: { readonly sessionId: string; readonly segment: number } | undefined;

  /** Drops the oldest segments not in flight past either bound, never the newest. */
  const bound = (): void => {
    const total = (): number => pending.length + (active === undefined ? 0 : 1);
    const bytes = (): number => pending.reduce((n, i) => n + i.body.byteLength, 0);
    while (pending.length > 1 && (total() > o.maxQueue || bytes() > o.maxQueueBytes)) pending.shift();
  };

  const finish = (gen: number): void => {
    if (gen !== generation) return;
    active = undefined;
    pump();
  };

  const attempt = async (item: Item, gen: number): Promise<void> => {
    if (gen !== generation) return;
    item.attempts++;
    const params = new URLSearchParams({
      service: o.service,
      session: item.sessionId,
      segment: String(item.segment),
      sent_at: String(o.now()),
    });
    if (o.clientToken !== undefined) params.set("client_token", o.clientToken);
    const url = `${o.url}${o.url.includes("?") ? "&" : "?"}${params.toString()}`;
    let wait: number | undefined;
    try {
      const res = await o.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
        body: item.body as BodyInit,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        keepalive: item.body.byteLength <= KEEPALIVE_MAX_BYTES,
      });
      if (res.status === 429 || res.status === 503)
        wait = retryAfter(res.headers.get("Retry-After"), o.now());
    } catch {
      wait = DEFAULT_RETRY_MILLIS;
    }
    if (gen !== generation) return;
    if (wait === undefined || item.attempts >= MAX_ATTEMPTS) {
      finish(gen);
      return;
    }
    retryTimer = o.timers.setTimeout(() => {
      retryTimer = undefined;
      void attempt(item, gen);
    }, wait);
  };

  const pump = (): void => {
    if (active !== undefined) return;
    const item = pending.shift();
    if (item === undefined) return;
    if (!o.allowed(item.sessionId)) {
      pump();
      return;
    }
    active = item;
    const gen = generation;
    o.allocate(item.sessionId).then(
      (segment) => {
        if (gen !== generation) return;
        item.segment = segment;
        last = { sessionId: item.sessionId, segment };
        void attempt(item, gen);
      },
      () => finish(gen),
    );
  };

  return {
    enqueue(sessionId, envelope) {
      const gen = generation;
      compressing = compressing
        .then(() => gzipJson(envelope))
        .then(
          (body) => {
            if (gen !== generation) return;
            pending.push({ sessionId, body, attempts: 0 });
            bound();
            pump();
          },
          () => {},
        );
    },
    clear() {
      generation++;
      pending = [];
      active = undefined;
      last = undefined;
      if (retryTimer !== undefined) o.timers.clearTimeout(retryTimer);
      retryTimer = undefined;
    },
    currentSegment: (sessionId) => (last?.sessionId === sessionId ? last.segment : undefined),
  };
}
