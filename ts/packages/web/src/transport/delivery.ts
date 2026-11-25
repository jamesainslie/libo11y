/**
 * WP1 (transport). Delivery: the gate, persist-first, retry from the queue, Retry-After and drain.
 */
import { diag } from "@opentelemetry/api";
import type { OtlpBatch } from "../contracts/otlp.ts";
import type { QueueEntry } from "../contracts/queue.ts";
import type {
  Delivery,
  DeliveryOptions,
  DeliveryResult,
  SendMode,
  SendResult,
} from "../contracts/transport.ts";
import { backoffDelay } from "./retry.ts";

const SENT: DeliveryResult = { outcome: "sent" };
const QUEUED: DeliveryResult = { outcome: "queued" };
const GATE_DROP: DeliveryResult = { outcome: "dropped" };

function navigatorOnline(): boolean {
  return (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine !== false;
}

function globalEvents(): EventTarget | undefined {
  return typeof (globalThis as { addEventListener?: unknown }).addEventListener === "function"
    ? (globalThis as unknown as EventTarget)
    : undefined;
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms) as unknown as { unref?: () => void };
  // Outside a browser a pending retry must not keep the process alive.
  handle.unref?.();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// dropped reports a lost batch through diag and returns the result that carries the error.
function dropped(signal: string, reason: string, cause?: unknown): DeliveryResult {
  const error = new Error(
    `libo11y: ${signal} batch dropped: ${reason}`,
    cause === undefined ? {} : { cause },
  );
  diag.warn(error.message);
  return { outcome: "dropped", error };
}

/**
 * Builds a Delivery.
 *
 * deliver(batch): with the gate closed, "dropped" with no error and no side effect. With
 * persistFirst, the batch is put leased, sent, then removed on ok, removed on fatal, or rescheduled
 * on retry ("queued"); if put stores nothing the batch is still sent once. Without persistFirst it
 * is sent; a retry result puts it with notBefore from backoffDelay(1), or Retry-After when that is
 * longer ("queued"),
 * and a fatal one is "dropped" with an error. When isOnline() is false the batch skips the attempt
 * and is queued. Every "queued" outcome schedules a drain.
 *
 * drain(): as the contract says. Each claimed entry is sent; ok and fatal remove it, retry
 * reschedules it after backoffDelay(attempts + 1), or Retry-After when that is longer. A round stops
 * before an entry with less than half its lease left, so a slow collector never lets another tab
 * claim an entry this one is about to send. The "online" event
 * on events triggers a drain. Timers are cleared by clear and shutdown.
 */
export function createDelivery(opts: DeliveryOptions): Delivery {
  const { transport, queue, gate } = opts;
  const persistFirst = opts.persistFirst ?? false;
  const mode = opts.mode ?? ((): SendMode => "normal");
  const isOnline = opts.isOnline ?? navigatorOnline;
  const events = "events" in opts ? opts.events : globalEvents();
  const initialBackoffMillis = opts.initialBackoffMillis ?? 1000;
  const maxBackoffMillis = opts.maxBackoffMillis ?? 300_000;
  const maxRetryAfterMillis = opts.maxRetryAfterMillis ?? 3_600_000;
  const leaseMillis = opts.leaseMillis ?? 30_000;
  const drainBatch = opts.drainBatch ?? 10;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const setTimer = opts.setTimer ?? defaultSetTimer;
  const clearTimer = opts.clearTimer ?? defaultClearTimer;

  let timer: unknown;
  let hasTimer = false;
  let draining: Promise<void> | undefined;
  let stopped = false;

  function cancelTimer(): void {
    if (!hasTimer) return;
    hasTimer = false;
    clearTimer(timer);
    timer = undefined;
  }

  function armIn(ms: number): void {
    cancelTimer();
    hasTimer = true;
    timer = setTimer(
      () => {
        hasTimer = false;
        timer = undefined;
        void drain();
      },
      Math.max(0, ms),
    );
  }

  // arm keeps exactly one timer, for the queue's next due entry, or none when it is empty.
  async function arm(): Promise<void> {
    if (queue === undefined || stopped) return;
    const due = await queue.nextDue();
    if (stopped) return;
    if (due === undefined) cancelTimer();
    else armIn(due - now());
  }

  // retryDelay honours Retry-After (clamped to maxRetryAfterMillis) as a lower bound on the backoff,
  // so a collector answering "Retry-After: 0" to every request still sees the delay grow.
  function retryDelay(result: SendResult & { kind: "retry" }, attempt: number): number {
    const backoff = backoffDelay(attempt, initialBackoffMillis, maxBackoffMillis, random);
    if (result.retryAfterMillis === undefined) return backoff;
    return Math.max(Math.min(result.retryAfterMillis, maxRetryAfterMillis), backoff);
  }

  async function attempt(batch: OtlpBatch, m: SendMode): Promise<SendResult> {
    try {
      return await transport.send({ signal: batch.signal, body: batch.body, mode: m });
    } catch (err) {
      return { kind: "fatal", reason: `transport failed: ${message(err)}` };
    }
  }

  // enqueue stores a batch that failed retryably for a later attempt.
  async function enqueue(batch: OtlpBatch, notBefore: number, reason: string): Promise<DeliveryResult> {
    if (queue === undefined) return dropped(batch.signal, `${reason}, and there is no retry queue`);
    // Consent may have been revoked, and the queue cleared, while the attempt was on the wire. The
    // check and the put run in one turn, so a clear() issued after the gate closed comes after it.
    if (!gate.recording()) return GATE_DROP;
    const entry = await queue.put({ signal: batch.signal, body: batch.body, notBefore });
    if (entry === undefined) return dropped(batch.signal, `${reason}, and the retry queue refused it`);
    diag.debug(`libo11y: ${batch.signal} batch queued for retry: ${reason}`);
    await arm();
    return QUEUED;
  }

  async function deliverPersisted(batch: OtlpBatch): Promise<DeliveryResult> {
    if (queue === undefined) return deliverDirect(batch);
    const entry = await queue.put({ signal: batch.signal, body: batch.body, leaseMillis });
    if (!gate.recording()) {
      if (entry !== undefined) await queue.remove([entry.id]);
      return GATE_DROP;
    }
    if (entry === undefined) {
      // The queue refused it (larger than the queue's bound): one attempt, no retry.
      const result = await attempt(batch, mode());
      if (result.kind === "ok") return SENT;
      return dropped(batch.signal, `${result.reason}, and the queue refused it`);
    }
    if (!isOnline()) {
      // Release the lease so the drain on "online" can claim it at once.
      await queue.reschedule(entry.id, now());
      await arm();
      return QUEUED;
    }
    const result = await attempt(batch, mode());
    if (result.kind === "ok") {
      await queue.remove([entry.id]);
      return SENT;
    }
    if (result.kind === "fatal") {
      await queue.remove([entry.id]);
      return dropped(batch.signal, result.reason);
    }
    if (!gate.recording()) {
      // Revoked while the attempt was on the wire: keep nothing.
      await queue.remove([entry.id]);
      return GATE_DROP;
    }
    await queue.reschedule(entry.id, now() + retryDelay(result, 1));
    await arm();
    return QUEUED;
  }

  async function deliverDirect(batch: OtlpBatch): Promise<DeliveryResult> {
    if (!isOnline()) return enqueue(batch, now(), "offline");
    const result = await attempt(batch, mode());
    if (result.kind === "ok") return SENT;
    if (result.kind === "fatal") return dropped(batch.signal, result.reason);
    return enqueue(batch, now() + retryDelay(result, 1), result.reason);
  }

  function canDrain(): boolean {
    return queue !== undefined && !stopped && gate.recording() && mode() !== "unload" && isOnline();
  }

  // settleEntry applies one drain attempt's result; true when it was a retry.
  async function settleEntry(entry: QueueEntry, result: SendResult): Promise<boolean> {
    if (queue === undefined) return false;
    if (result.kind === "retry") {
      await queue.reschedule(entry.id, now() + retryDelay(result, entry.attempts + 1));
      return true;
    }
    if (result.kind === "fatal") dropped(entry.signal, result.reason);
    await queue.remove([entry.id]);
    return false;
  }

  async function drainRounds(): Promise<void> {
    if (queue === undefined) return;
    // Round after round while the collector accepts; a round with a retry ends the drain, and the
    // timer picks up the rescheduled entries when they are due.
    let more = true;
    while (more && canDrain()) {
      const entries = await queue.claim(now(), drainBatch, leaseMillis);
      if (entries.length === 0) break;
      let retried = false;
      for (const entry of entries) {
        // A claimed entry left unsent keeps its lease, which simply runs out.
        if (!gate.recording() || stopped) return;
        // The entries of a round are sent one after another, so a slow collector can use up the
        // lease. Once less than half of it is left, another tab could claim the entry while this
        // attempt is still on the wire and send it twice; leave the rest for when the lease ends.
        if (entry.leaseUntil - now() < leaseMillis / 2) {
          more = false;
          break;
        }
        retried = (await settleEntry(entry, await attempt(entry, "normal"))) || retried;
      }
      if (retried) more = false;
    }
    await arm();
  }

  // armHidden looks again later while the page is hidden, no sooner than the initial backoff, and
  // only while something is queued, so an idle hidden page keeps no timer.
  async function armHidden(): Promise<void> {
    if (queue === undefined || stopped) return;
    const due = await queue.nextDue();
    if (stopped) return;
    if (due === undefined) cancelTimer();
    else armIn(Math.max(due - now(), initialBackoffMillis));
  }

  function drain(): Promise<void> {
    if (draining !== undefined) return draining;
    if (!canDrain()) {
      // A hidden page does not drain; look again later rather than wait for the next event.
      if (queue !== undefined && !stopped && gate.recording() && mode() === "unload") {
        return armHidden().catch((err: unknown) => {
          diag.warn(`libo11y: scheduling the retry queue failed: ${message(err)}`);
        });
      }
      return Promise.resolve();
    }
    const run = drainRounds()
      .catch((err: unknown) => {
        diag.warn(`libo11y: draining the retry queue failed: ${message(err)}`);
      })
      .finally(() => {
        draining = undefined;
      });
    draining = run;
    return run;
  }

  const onOnline = (): void => {
    void drain();
  };
  events?.addEventListener("online", onOnline);
  const unsubscribe = gate.subscribe((open) => {
    if (open) void drain();
  });

  return {
    async deliver(batch) {
      if (!gate.recording()) return GATE_DROP;
      try {
        return persistFirst ? await deliverPersisted(batch) : await deliverDirect(batch);
      } catch (err) {
        return dropped(batch.signal, message(err), err);
      }
    },
    drain,
    async clear() {
      cancelTimer();
      while (draining !== undefined) await draining;
      try {
        await queue?.clear();
      } catch (err) {
        diag.warn(`libo11y: clearing the retry queue failed: ${message(err)}`);
      }
      cancelTimer();
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      cancelTimer();
      events?.removeEventListener("online", onOnline);
      unsubscribe();
      while (draining !== undefined) await draining;
      cancelTimer();
    },
  };
}
