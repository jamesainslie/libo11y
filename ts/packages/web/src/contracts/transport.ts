/**
 * Contract, frozen by the L4 scaffold. Changing it needs the architect's sign-off.
 *
 * Two layers. A Transport makes exactly one attempt to send one batch (WP1 builds the HTTP one; WP5
 * builds one over extension messaging). A Delivery owns everything around attempts: the consent
 * gate, persist-first, retry with backoff from the PersistentQueue, Retry-After, the online event
 * and revocation. The exporters (WP1) sit on a Delivery.
 */
import type { RecordingGate } from "@libo11y/core";
import type { OtlpBatch } from "./otlp.ts";
import type { PersistentQueue } from "./queue.ts";

/** How an attempt may be sent. */
export type SendMode =
  /** A normal fetch, gzip-compressed when compression is on and CompressionStream exists. */
  | "normal"
  /**
   * The page is being hidden or unloaded: fetch with keepalive, else navigator.sendBeacon. Both cap
   * the body (and keepalive the bytes in flight per document) at 64 KiB.
   */
  | "unload";

/** One send attempt. */
export interface SendRequest extends OtlpBatch {
  readonly mode: SendMode;
}

/** The outcome of one attempt. */
export type SendResult =
  /** 2xx, or a beacon the browser accepted. */
  | { readonly kind: "ok" }
  /**
   * Worth trying again: offline, a network error, a timeout, 408, 429, 502, 503, 504, or an unload
   * send refused by the keepalive or beacon budget. retryAfterMillis is the parsed Retry-After.
   */
  | { readonly kind: "retry"; readonly reason: string; readonly retryAfterMillis?: number }
  /**
   * Never worth retrying: any other status, or a signal without a URL. An unload body that does not
   * fit is a retry ("unload budget"), so a later normal-mode drain sends it.
   */
  | { readonly kind: "fatal"; readonly reason: string; readonly status?: number };

/** Makes single send attempts. Never rejects. */
export interface Transport {
  send(req: SendRequest): Promise<SendResult>;
}

/** What happened to a delivered batch on its first attempt. */
export type DeliveryOutcome =
  /** The first attempt succeeded. */
  | "sent"
  /** Stored in the queue for a later attempt; it is durable when kind is "indexeddb". */
  | "queued"
  /** Not sent and not kept: the gate was closed, the error was fatal, or the queue refused it. */
  | "dropped";

/** The result of Delivery.deliver. error is set when outcome is "dropped" for a reason other than the gate. */
export interface DeliveryResult {
  readonly outcome: DeliveryOutcome;
  readonly error?: Error;
}

/** Options for createDelivery (WP1). */
export interface DeliveryOptions {
  readonly transport: Transport;
  /** The retry queue. Without one a retryable failure is dropped. */
  readonly queue?: PersistentQueue;
  /** The consent gate. While closed nothing is sent, queued or drained. */
  readonly gate: RecordingGate;
  /**
   * Put every batch into the queue (leased) before its first attempt, and remove it after. The
   * webext service worker sets it, because the worker can be stopped at any moment. Default false:
   * a batch is queued only after a retryable failure.
   */
  readonly persistFirst?: boolean;
  /** Decides the mode of each attempt. Default: always "normal". The web platform passes visibility. */
  readonly mode?: () => SendMode;
  /** Whether the runtime believes it is online. Default () => navigator.onLine !== false. */
  readonly isOnline?: () => boolean;
  /** Where to listen for "online" to drain the queue. Default globalThis when it has addEventListener. */
  readonly events?: EventTarget;
  /** First retry delay; doubles per attempt with full jitter. Default 1000. */
  readonly initialBackoffMillis?: number;
  /** The largest computed retry delay. Default 300_000. */
  readonly maxBackoffMillis?: number;
  /** The largest Retry-After honoured; longer values are clamped. Default 3_600_000. */
  readonly maxRetryAfterMillis?: number;
  /** How long a claim leases entries. Default 30_000. */
  readonly leaseMillis?: number;
  /** Entries claimed per drain round. Default 10. */
  readonly drainBatch?: number;
  /** Injectable clock, randomness and timers for tests. */
  readonly now?: () => number;
  readonly random?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** Delivers batches through a Transport with the gate, the queue and retry around it. */
export interface Delivery {
  /** Sends one batch, or queues it for retry. Never rejects. */
  deliver(batch: OtlpBatch): Promise<DeliveryResult>;
  /**
   * Claims and sends every due queued entry, round after round, until none is due, then arms one
   * timer for queue.nextDue(). A no-op while the gate is closed or another drain runs.
   */
  drain(): Promise<void>;
  /** Cancels the retry timer and clears the queue. Consent revocation calls it. */
  clear(): Promise<void>;
  /** Cancels the timer and stops listening; queued entries stay for the next page or wake. */
  shutdown(): Promise<void>;
}
