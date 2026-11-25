/**
 * Shutting down on a termination signal (Go ShutdownOnSignals). One listener per signal is
 * registered with once; the first signal removes the others, so a second signal gets the runtime's
 * default handling and ends the process. The process is never exited here.
 *
 * beforeShutdown and the telemetry shutdown share one deadline, and together never take longer
 * than it. beforeShutdown may use nine tenths of the deadline. The shutdown gets whatever is left
 * of the whole, which is then never less than a tenth, so the buffered telemetry has a chance to
 * leave even when beforeShutdown used all it was allowed.
 */
import type { SignalReport, Telemetry } from "@libo11y/core";

/** Where signals come from: process, or a test's emitter. */
export interface SignalSource {
  once(signal: string, listener: () => void): unknown;
  removeListener(signal: string, listener: () => void): unknown;
}

/** The clock and timers shutdownOnSignals uses. A test replaces them to decide when time passes. */
export interface SignalClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: SignalClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Options for shutdownOnSignals. */
export interface ShutdownOnSignalsOptions {
  /** The signal names to wait for. Default ["SIGINT", "SIGTERM"]. */
  readonly signals?: readonly string[];
  /**
   * The one deadline for beforeShutdown and the telemetry shutdown together, in milliseconds.
   * Default 5000, shutdown's own. A negative value is 0 and anything past 2147483647 is that. A
   * string that reads as a finite number is taken as that number, and any other value that is not
   * a number is the default.
   */
  readonly timeoutMillis?: number;
  /**
   * Runs after the signal and before the telemetry shuts down, to stop what still makes telemetry:
   * typically the server, so requests in flight finish and their spans and metrics are exported.
   * It may take nine tenths of timeoutMillis. The shutdown runs when it settles or that time has
   * passed, with what is left of timeoutMillis. A throw, a rejection or running out of time is
   * reported in the shutdown report as a "lifecycle" error, never thrown.
   */
  readonly beforeShutdown?: () => Promise<void> | void;
}

const DEFAULT_SIGNALS: readonly string[] = ["SIGINT", "SIGTERM"];

const DEFAULT_TIMEOUT_MILLIS = 5000;

/** The longest delay a timer takes: setTimeout treats anything larger as 1 ms. */
const MAX_TIMEOUT_MILLIS = 2 ** 31 - 1;

/** The share of the deadline beforeShutdown may use. The rest is the telemetry shutdown's. */
const BEFORE_SHUTDOWN_SHARE = 0.9;

// deadlineOf reads a deadline as Telemetry.shutdown does. A number is clamped to what a timer can
// wait: negative is 0, and Infinity or anything past the timer maximum is the maximum. A string
// that reads as a finite number is that number. NaN, any other string and any other value are the
// default.
function deadlineOf(given: unknown): number {
  const ms = typeof given === "string" && given.trim() !== "" ? Number(given) : given;
  if (typeof ms !== "number" || Number.isNaN(ms)) return DEFAULT_TIMEOUT_MILLIS;
  return Math.min(Math.max(ms, 0), MAX_TIMEOUT_MILLIS);
}

/** shutdownOnSignals with the signals taken from source. clock is for tests. */
export function shutdownOnSignalsWith(
  source: SignalSource,
  telemetry: Telemetry,
  opts: ShutdownOnSignalsOptions = {},
  clock: SignalClock = REAL_CLOCK,
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
    if (opts.beforeShutdown === undefined) {
      return telemetry.shutdown(
        opts.timeoutMillis === undefined ? {} : { timeoutMillis: opts.timeoutMillis },
      );
    }
    const deadline = deadlineOf(opts.timeoutMillis);
    const allowed = deadline * BEFORE_SHUTDOWN_SHARE;
    const started = clock.now();
    const before = await runBefore(opts.beforeShutdown, allowed, clock);
    // A timer can fire late. beforeShutdown is charged what it was allowed at most, so the
    // shutdown always has its tenth.
    const used = Math.min(Math.max(clock.now() - started, 0), allowed);
    const report = await telemetry.shutdown({ timeoutMillis: deadline - used });
    if (before === undefined) return report;
    return { ok: false, errors: [{ signal: "lifecycle", error: before.error }, ...report.errors] };
  });
}

/** Runs fn within ms, and returns what went wrong, if anything. */
async function runBefore(
  fn: () => Promise<void> | void,
  ms: number,
  clock: SignalClock,
): Promise<{ error: Error } | undefined> {
  let timer: unknown;
  const expired = new Promise<{ error: Error }>((resolve) => {
    timer = clock.setTimeout(
      () => resolve({ error: new Error("o11y: beforeShutdown: deadline exceeded") }),
      ms,
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
    clock.clearTimeout(timer);
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
