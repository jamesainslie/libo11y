/**
 * Flushes nobody awaits: on hide, when an app goes to the background, when RUM sends what a kept
 * session retained. Core's forceFlush never rejects. It resolves with a report, and a caller that
 * does not look at it loses the news that telemetry was dropped. reportFlush says a report that is
 * not ok, once, through the telemetry's own reporter, so a createTelemetry handle, which installs
 * nothing globally, still writes it to its diagnostic stream.
 *
 * A report names the step, each failed signal and the class of its error, never the error's
 * message, which can quote an endpoint or a header. The report itself stays on the cause.
 *
 * reportError uses the same path for a failure of the fetch and XHR instrumentation itself.
 */
import type { SignalReport, Telemetry } from "@libo11y/core";
import { globalErrorHandler } from "@opentelemetry/core";

/**
 * The key under which a telemetry handle from @libo11y/core carries its reporter. A registered
 * symbol, so it is found without importing core's internals.
 */
const REPORT_KEY = Symbol.for("libo11y.report");

const CLASS_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

// errorClass is the class of what failed: the cause core wrapped it around when there is one (the
// first of a list, as upstream's tracer provider rejects with), its constructor's name when that
// reads as a class name, else "Error" or the value's type.
function errorClass(err: unknown): string {
  try {
    const cause = err instanceof Error && err.cause !== undefined ? err.cause : err;
    const inner: unknown = Array.isArray(cause) && cause.length > 0 ? cause[0] : cause;
    if (inner === null) return "null";
    if (typeof inner !== "object") return typeof inner;
    const name: unknown = (inner as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === "string" && CLASS_NAME.test(name)) return name;
    return inner instanceof Error ? "Error" : "object";
  } catch {
    return "unknown";
  }
}

function send(telemetry: Telemetry | undefined, report: Error): void {
  try {
    const own: unknown = (telemetry as { [REPORT_KEY]?: unknown } | undefined)?.[REPORT_KEY];
    if (typeof own === "function") {
      own.call(telemetry, report);
      return;
    }
  } catch {
    // A reporter that fails leaves the global handler.
  }
  try {
    globalErrorHandler(report);
  } catch {
    // Reporting is best effort.
  }
}

/**
 * Reports report through telemetry's own reporter when it is not ok: one error, "o11y: <what>
 * failed: <signal> (<class>), ...". It never throws.
 */
export function reportFlush(telemetry: Telemetry, what: string, report: SignalReport): void {
  if (report.ok) return;
  const failed = report.errors.map((e) => `${e.signal} (${errorClass(e.error)})`).join(", ");
  send(telemetry, new Error(`o11y: ${what} failed: ${failed}`, { cause: report }));
}

/**
 * Flushes telemetry and reports a report that is not ok, as reportFlush does. Resolves with the
 * report and never rejects: a flush that throws anyway is reported by its class and resolves as a
 * lifecycle failure.
 */
export async function flushInBackground(telemetry: Telemetry, what: string): Promise<SignalReport> {
  let report: SignalReport;
  try {
    report = await telemetry.forceFlush();
  } catch (err) {
    send(telemetry, new Error(`o11y: ${what} failed: ${errorClass(err)}`, { cause: err }));
    return { ok: false, errors: [{ signal: "lifecycle", error: err }] };
  }
  reportFlush(telemetry, what, report);
  return report;
}

/**
 * Reports a failure of the instrumentation itself, which must never reach the request it wraps:
 * one error, "o11y: <what>: <class>", through telemetry's own reporter when it has one, else the
 * global error handler. The thrown value stays on the cause, never in the message. It never throws.
 */
export function reportError(telemetry: Telemetry | undefined, what: string, err: unknown): void {
  send(telemetry, new Error(`o11y: ${what}: ${errorClass(err)}`, { cause: err }));
}
