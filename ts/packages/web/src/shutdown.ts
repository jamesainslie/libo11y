/**
 * Browser shutdown under the caller's one deadline: core's providers first, then the delivery's
 * teardown in what is left of the deadline.
 */
import type { LifecycleOptions, SignalReport } from "@libo11y/core";
import { diag } from "@opentelemetry/api";
import type { OtlpSignal } from "./contracts/otlp.ts";
import type { Delivery } from "./contracts/transport.ts";

/** LifecycleOptions.timeoutMillis when none is given, as in core. */
const DEFAULT_TIMEOUT_MILLIS = 5000;
/** The longest a timer can wait. */
const MAX_TIMEOUT_MILLIS = 2_147_483_647;

// clampTimeout reads the caller's deadline as core does: a negative number is 0, anything past
// the timer maximum is that, a string that reads as a finite number is that number, and any
// other value is the default.
function clampTimeout(given: unknown): number {
  const ms = typeof given === "string" && given.trim() !== "" ? Number(given) : given;
  if (typeof ms !== "number" || Number.isNaN(ms)) return DEFAULT_TIMEOUT_MILLIS;
  return Math.min(Math.max(ms, 0), MAX_TIMEOUT_MILLIS);
}

/**
 * Runs core's shutdown with opts, then shuts delivery down with the rest of the same deadline.
 * Each signal with an attempt still in flight when the deadline passed gets core's error for a
 * missed deadline, "o11y: shutdown <signal>: deadline exceeded", unless core already reported an
 * error for it. Never rejects.
 */
export async function shutdownWithin(
  coreShutdown: (opts?: LifecycleOptions) => Promise<SignalReport>,
  delivery: Delivery,
  opts: LifecycleOptions | undefined,
): Promise<SignalReport> {
  const timeoutMillis = clampTimeout(opts?.timeoutMillis);
  const started = Date.now();
  const report = await coreShutdown(opts);
  let timedOut: readonly OtlpSignal[] = [];
  try {
    const left = Math.max(0, timeoutMillis - (Date.now() - started));
    timedOut = (await delivery.shutdown({ timeoutMillis: left })).timedOut;
  } catch (err) {
    diag.warn("o11y: shutting the delivery down failed", err);
  }
  const errors = [...report.errors];
  for (const signal of timedOut) {
    if (errors.some((e) => e.signal === signal)) continue;
    errors.push({ signal, error: new Error(`o11y: shutdown ${signal}: deadline exceeded`) });
  }
  return errors.length === report.errors.length ? report : { ok: false, errors };
}
