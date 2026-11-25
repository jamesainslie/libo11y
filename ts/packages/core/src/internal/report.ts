/**
 * How libo11y reports a failure of its own to a diagnostic stream.
 *
 * A report never repeats the message of what was thrown. A message can carry the value that made
 * the call fail: new URL(value) and JSON.parse(value) both quote their input, and a replacer or a
 * getter is handed attribute values. So a report names the step that failed, the class of the
 * error, and the attribute key where there is one. The error itself stays on the report's cause,
 * for a handler that wants it.
 */

const CLASS_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

/**
 * The class of a thrown value, for a report: its constructor's name when that reads as a class
 * name, "Error" for any other error, and the value's type for anything that is not an object. It
 * never throws and never returns the value's own text.
 */
export function errorClass(thrown: unknown): string {
  try {
    if (thrown === null) return "null";
    if (typeof thrown !== "object") return typeof thrown;
    const name: unknown = (thrown as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === "string" && CLASS_NAME.test(name)) return name;
    return thrown instanceof Error ? "Error" : "object";
  } catch {
    return "unknown";
  }
}

/** A report that step failed: "<step>: <class of cause>", with cause attached. */
export function failure(step: string, cause: unknown): Error {
  return new Error(`${step}: ${errorClass(cause)}`, { cause });
}

/** Where a report goes: a telemetry's own rate-limited handler, or the global error handler. */
export type Report = (err: Error) => void;

/** What a kind of attribute is called in a report, such as "log attribute" and "log attributes". */
export interface AttributeNoun {
  readonly one: string;
  readonly all: string;
}

/** A report that the attribute at path and key cannot be read: the dotted key, never the value. */
export function unreadable(noun: AttributeNoun, path: readonly string[], key: string, cause: unknown): Error {
  const name = [...path, key].filter((segment) => segment !== "").join(".");
  return failure(`o11y: ${noun.one} ${JSON.stringify(name)} cannot be read and is dropped`, cause);
}

/**
 * Copies the own members of attrs onto out, as { ...out, ...attrs } would, reading each once. A
 * member that cannot be read is dropped and reported, and so are attributes whose keys cannot be
 * listed, such as a revoked proxy. It never throws, whatever attrs is.
 */
export function readInto(
  out: { [key: string]: unknown },
  attrs: unknown,
  noun: AttributeNoun,
  report: Report,
): void {
  if (attrs === undefined || attrs === null) return;
  let keys: string[];
  try {
    keys = Object.keys(attrs);
  } catch (err) {
    report(failure(`o11y: ${noun.all} cannot be read and are dropped`, err));
    return;
  }
  for (const k of keys) {
    try {
      out[k] = (attrs as { [key: string]: unknown })[k];
    } catch (err) {
      report(unreadable(noun, [], k, err));
    }
  }
}

/**
 * The reporter a call should use: the one target carries under REPORT_KEY when it is a telemetry
 * handle, else fallback. It never throws, whatever target is.
 */
export function reporterOf(target: unknown, fallback: Report): Report {
  try {
    const own: unknown = (target as { [REPORT_KEY]?: unknown } | null | undefined)?.[REPORT_KEY];
    if (typeof own === "function") return (err) => own.call(target, err);
  } catch {
    // Whatever target is, the fallback still reports.
  }
  return fallback;
}

/**
 * The key under which a telemetry handle carries its reporter for instrumentation built on core,
 * such as @libo11y/server's instrumentFetch and instrumentServe: a function that takes one error
 * and writes it through the handle's own rate-limited handler. It is a registered symbol, so a
 * package finds it without importing anything from core, and across two copies of core.
 */
export const REPORT_KEY: unique symbol = Symbol.for("libo11y.report") as never;
