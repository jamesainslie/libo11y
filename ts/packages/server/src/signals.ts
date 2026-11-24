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
  /** The shutdown deadline. Default: shutdown's own, 5000 ms. */
  readonly timeoutMillis?: number;
}

const DEFAULT_SIGNALS: readonly string[] = ["SIGINT", "SIGTERM"];

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
  }).then(() =>
    telemetry.shutdown(opts.timeoutMillis === undefined ? {} : { timeoutMillis: opts.timeoutMillis }),
  );
}

/**
 * Resolves with the shutdown report once the process receives one of opts.signals (default SIGINT
 * and SIGTERM). Until then each of those signals has a listener, which replaces the runtime's
 * default handling; after the first, they are all removed, so a second signal ends the process.
 */
export function shutdownOnSignals(
  telemetry: Telemetry,
  opts?: ShutdownOnSignalsOptions,
): Promise<SignalReport> {
  return shutdownOnSignalsWith(process as unknown as SignalSource, telemetry, opts);
}
