/**
 * Captures what the instrumentation reports while fn runs, as the server's test support does. A
 * report goes to the telemetry handle's own reporter when the instrumentation was given a handle,
 * and otherwise to the OpenTelemetry global error handler. Both are captured: the global handler
 * for the duration, and the reporter of each handle passed in.
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
}

export async function capturingErrors<T>(
  fn: () => T | Promise<T>,
  ...handles: Telemetry[]
): Promise<Captured<T>> {
  const errors: string[] = [];
  const viaHandle: string[] = [];
  const viaGlobal: string[] = [];
  const capture =
    (into: string[]) =>
    (err: unknown): void => {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      into.push(message);
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
    return { result: await fn(), errors, viaHandle, viaGlobal };
  } finally {
    for (const undo of restore) undo();
    setGlobalErrorHandler(loggingErrorHandler());
  }
}
