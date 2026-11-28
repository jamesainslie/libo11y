/**
 * Watches the exports of one signal, so the lifecycle can say and do what the upstream batch
 * processors and periodic reader leave out.
 *
 * Reporting. sdk-logs' batch processor and sdk-metrics' periodic reader hand a failed export to the
 * global error handler and then resolve their flush and shutdown, so a caller that awaits them never
 * learns the telemetry was lost. The watch sits between the processor and the exporter. A flush or
 * a shutdown observes it while it runs, and adds the first export that failed in that time to its
 * report. An export that fails while nothing observes, as one the batch timer or the periodic
 * reader starts on its own does, goes to the watch's onUnobserved instead, so the telemetry can
 * say the signal was dropped. A failure reaches one of the two, never both, so it is told once.
 *
 * Stopping. An exporter that never answers leaves two things behind after the shutdown deadline:
 * the processor's export timer, which keeps the process alive until it fires, and whatever the
 * exporter itself still holds, such as a socket. close() fails every export still waiting for its
 * result, which clears the processor's timer, and calls the exporter's shutdown() if nothing has
 * yet, so the exporter can let go of what it holds.
 *
 * The contract with an exporter is the OpenTelemetry one: shutdown() stops it and does not wait
 * for the collector. On a clean stop the watch calls it only once every export has reported its
 * result, and after the deadline there is nothing left to wait for.
 *
 * An export gets the processor's own export timeout to report its result. Past it the watch fails
 * the export itself, as the processor does at the same moment, so one export that never calls back
 * cannot keep a later flush or shutdown waiting.
 */
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { after, nextTurn } from "./internal/timers.ts";

/** What span, log record and metric exporters have in common. */
export interface WatchedExporter<T> {
  export(items: T, resultCallback: (result: ExportResult) => void): void;
  forceFlush?(): Promise<void>;
  shutdown(): Promise<void>;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function failed(message: string): ExportResult {
  return { code: ExportResultCode.FAILED, error: new Error(message) };
}

/** What one flush or shutdown saw of a signal's exports while it ran. */
export interface ExportObservation {
  /** The first export that failed since the observation began, if any. */
  failure(): { readonly error: unknown } | undefined;
  /** Ends the observation. */
  end(): void;
}

/** The watch over one signal's exporters. */
export class ExportWatch {
  private readonly timeoutMillis: number;
  private readonly observers = new Set<(error: unknown) => void>();
  private closed = false;
  /** Each export waiting for its result, with the promise that resolves when it has reported. */
  private readonly pending = new Map<(result: ExportResult) => void, Promise<void>>();
  private readonly stops: (() => void)[] = [];
  private readonly onUnobserved: ((error: unknown) => void) | undefined;

  /**
   * timeoutMillis is how long one export may take to report its result: the export timeout.
   * onUnobserved hears of each export that fails while no flush or shutdown observes the watch and
   * before it is closed. An export close() fails is left out: the shutdown that closes reports it.
   */
  constructor(timeoutMillis: number, onUnobserved?: (error: unknown) => void) {
    this.timeoutMillis = timeoutMillis;
    this.onUnobserved = onUnobserved;
  }

  /**
   * Starts observing: the result reports on the exports that finish from here until end(). Each
   * flush and shutdown has its own, so two that overlap do not hide a failure from each other.
   */
  observe(): ExportObservation {
    let first: { readonly error: unknown } | undefined;
    const observer = (error: unknown): void => {
      first ??= { error };
    };
    this.observers.add(observer);
    return { failure: () => first, end: () => void this.observers.delete(observer) };
  }

  /**
   * Resolves once every export in flight at the time of the call has reported its result, or the
   * watch is closed. An export that starts later is not waited for, so a flush that asks does not
   * wait on the exports of the flushes that come after it.
   */
  inFlight(): Promise<void> {
    if (this.closed || this.pending.size === 0) return Promise.resolve();
    return Promise.all([...this.pending.values()]).then(() => undefined);
  }

  /**
   * Resolves once the watch has nothing in flight and stays that way for one turn of the event
   * loop, or is closed. A processor that sends batch after batch starts the next one a few
   * microtasks after a result, and the turn tells that gap from the end. Only a caller that knows
   * no new work is coming should wait for this: a shutdown, never a flush.
   */
  async idle(): Promise<void> {
    while (!this.closed) {
      await this.drained();
      if (this.closed) return;
      await nextTurn();
      if (this.pending.size === 0) return;
    }
  }

  // drained resolves as soon as nothing is in flight, or the watch is closed.
  private async drained(): Promise<void> {
    while (!this.closed && this.pending.size > 0) await this.inFlight();
  }

  /**
   * Returns inner as the processor should see it. An export that throws, or that does not report
   * within the export timeout, counts as a failed export. shutdown() waits for the exports in
   * flight before it stops inner. Once the watch is closed an export fails at once, and forceFlush()
   * and shutdown() resolve.
   */
  watch<T>(inner: WatchedExporter<T>): Required<WatchedExporter<T>> {
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopping ??= Promise.resolve().then(() => inner.shutdown());
      return stopping;
    };
    this.stops.push(() => {
      // Whatever a late stop does wrong, the signal has already been reported as it ended.
      stop().catch(() => {});
    });
    return {
      export: (items, resultCallback) => {
        if (this.closed) {
          resultCallback(failed("the exporter is stopped"));
          return;
        }
        let settled = false;
        let cancelTimeout = (): void => {};
        let reported = (): void => {};
        const done = new Promise<void>((resolve) => {
          reported = resolve;
        });
        const settle = (result: ExportResult): void => {
          if (settled) return;
          settled = true;
          cancelTimeout();
          this.pending.delete(settle);
          if (result.code !== ExportResultCode.SUCCESS) {
            const error = result.error ?? new Error("the export failed");
            if (this.observers.size > 0) for (const observer of this.observers) observer(error);
            else if (!this.closed) this.unobserved(error);
          }
          try {
            resultCallback(result);
          } finally {
            reported();
          }
        };
        this.pending.set(settle, done);
        try {
          cancelTimeout = after(this.timeoutMillis, () => settle(failed("the export timed out")));
          inner.export(items, settle);
        } catch (err) {
          settle({ code: ExportResultCode.FAILED, error: asError(err) });
        }
      },
      forceFlush: async () => {
        if (!this.closed) await inner.forceFlush?.();
      },
      shutdown: async () => {
        await this.drained();
        if (!this.closed) await stop();
      },
    };
  }

  private unobserved(error: unknown): void {
    try {
      this.onUnobserved?.(error);
    } catch {
      // Reporting is best effort, and must not keep the result from the processor.
    }
  }

  /**
   * Ends the watch, when the signal's shutdown has settled or its deadline has passed. Every export
   * still waiting is failed, so nothing upstream goes on waiting for it, and every exporter that
   * has not been stopped is told to stop. Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const settle of [...this.pending.keys()]) {
      try {
        settle(failed("the export was abandoned at shutdown"));
      } catch {
        // A processor's callback that throws has nothing left to report to here.
      }
    }
    for (const stop of this.stops) stop();
  }
}
