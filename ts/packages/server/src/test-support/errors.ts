/**
 * Captures what the instrumentation reports while fn runs. A report goes to the telemetry handle's
 * own reporter when the instrumentation was given a handle, and otherwise to the OpenTelemetry
 * global error handler. Both are captured: the global handler for the duration, and the reporter
 * of each handle passed in. The global handler is process-wide, so a test holds it only for the
 * calls it checks.
 */
import type { Telemetry } from "@libo11y/core";
import { loggingErrorHandler, setGlobalErrorHandler } from "@opentelemetry/core";

/** The key a telemetry handle carries its reporter under. */
const REPORT_KEY = Symbol.for("libo11y.report");

type Reporting = { [REPORT_KEY]?: ((err: unknown) => void) | undefined };

/** What was reported while a function ran. */
export interface Captured<T> {
  readonly result: T;
  /** Every report's message, in order, whichever way it went. */
  readonly errors: string[];
  /** The reports that went through a handle's own reporter. */
  readonly viaHandle: string[];
  /** The reports that went to the global error handler. */
  readonly viaGlobal: string[];
  /** Each report as it was made, so a test can look at its cause. */
  readonly reports: unknown[];
}

export async function capturingErrors<T>(
  fn: () => T | Promise<T>,
  ...handles: Telemetry[]
): Promise<Captured<T>> {
  const errors: string[] = [];
  const viaHandle: string[] = [];
  const viaGlobal: string[] = [];
  const reports: unknown[] = [];
  const capture =
    (into: string[]) =>
    (err: unknown): void => {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      into.push(message);
      reports.push(err);
    };
  setGlobalErrorHandler(capture(viaGlobal));
  const restore = handles.map((handle) => {
    const reporting = handle as unknown as Reporting;
    const own = reporting[REPORT_KEY];
    reporting[REPORT_KEY] = capture(viaHandle);
    return () => {
      reporting[REPORT_KEY] = own;
    };
  });
  try {
    return { result: await fn(), errors, viaHandle, viaGlobal, reports };
  } finally {
    for (const undo of restore) undo();
    setGlobalErrorHandler(loggingErrorHandler());
  }
}
