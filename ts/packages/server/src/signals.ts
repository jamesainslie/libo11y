/**
 * Shutting down on a termination signal (Go ShutdownOnSignals). One listener per signal is
 * registered with once; the first signal removes the others, so a second signal gets the runtime's
 * default handling and ends the process. The process is never exited here.
 */
import type { SignalReport, Telemetry } from "@libo11y/core";

/** Where signals come from: process, or a test's emitter. */
export interface SignalSource {
  once(signal: string, listener: () => void): unknown;
  removeListener(signal: string, listener: () => void): unknown;
}

/** Options for shutdownOnSignals. */
export interface ShutdownOnSignalsOptions {
  /** The signal names to wait for. Default ["SIGINT", "SIGTERM"]. */
  readonly signals?: readonly string[];
  /** The shutdown deadline, which also bounds beforeShutdown. Default: shutdown's own, 5000 ms. */
  readonly timeoutMillis?: number;
  /**
   * Runs after the signal and before the telemetry shuts down, to stop what still makes telemetry:
   * typically the server, so requests in flight finish and their spans and metrics are exported.
   * It gets the same deadline as the shutdown, timeoutMillis, and the shutdown runs when it
   * settles or the deadline passes. A throw, a rejection or the deadline passing is reported in
   * the shutdown report as a "lifecycle" error, never thrown.
   */
  readonly beforeShutdown?: () => Promise<void> | void;
}

const DEFAULT_SIGNALS: readonly string[] = ["SIGINT", "SIGTERM"];

const DEFAULT_TIMEOUT_MILLIS = 5000;

/** The longest delay a timer takes: setTimeout treats anything larger as 1 ms. */
const MAX_TIMEOUT_MILLIS = 2 ** 31 - 1;

/** shutdownOnSignals with the signals taken from source. */
export function shutdownOnSignalsWith(
  source: SignalSource,
  telemetry: Telemetry,
  opts: ShutdownOnSignalsOptions = {},
): Promise<SignalReport> {
  const signals = opts.signals ?? DEFAULT_SIGNALS;
  return new Promise<void>((resolve) => {
    const listeners = new Map<string, () => void>();
    for (const signal of signals) {
      const listener = (): void => {
        for (const [other, l] of listeners) if (other !== signal) source.removeListener(other, l);
        resolve();
      };
      listeners.set(signal, listener);
      source.once(signal, listener);
    }
  }).then(async () => {
    const before =
      opts.beforeShutdown === undefined
        ? undefined
        : await runBefore(opts.beforeShutdown, opts.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS);
    const report = await telemetry.shutdown(
      opts.timeoutMillis === undefined ? {} : { timeoutMillis: opts.timeoutMillis },
    );
    if (before === undefined) return report;
    return { ok: false, errors: [{ signal: "lifecycle", error: before.error }, ...report.errors] };
  });
}

/** Runs fn within ms, and returns what went wrong, if anything. */
async function runBefore(fn: () => Promise<void> | void, ms: number): Promise<{ error: Error } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<{ error: Error }>((resolve) => {
    timer = setTimeout(
      () => resolve({ error: new Error("o11y: beforeShutdown: deadline exceeded") }),
      Number.isNaN(ms) ? DEFAULT_TIMEOUT_MILLIS : Math.min(Math.max(ms, 0), MAX_TIMEOUT_MILLIS),
    );
  });
  const ran = Promise.resolve()
    .then(fn)
    .then(
      () => undefined,
      (err: unknown) => ({
        error: new Error(`o11y: beforeShutdown: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        }),
      }),
    );
  try {
    return await Promise.race([ran, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves with the shutdown report once the process receives one of opts.signals (default SIGINT
 * and SIGTERM). Until then each of those signals has a listener, which replaces the runtime's
 * default handling; after the first, they are all removed, so a second signal ends the process.
 * opts.beforeShutdown, when given, runs first, so the server can stop before its telemetry does.
 */
export function shutdownOnSignals(
  telemetry: Telemetry,
  opts?: ShutdownOnSignalsOptions,
): Promise<SignalReport> {
  return shutdownOnSignalsWith(process as unknown as SignalSource, telemetry, opts);
}
