/**
 * console.error as errors, on every platform: each call is recorded with source console, the
 * arguments rendered (errors by their message, the first error giving the type and stack, else type
 * ConsoleError), and the original console.error always runs. A call logging an error object waits
 * a task, so an error a React boundary records in the same task (React 19 logs it before
 * componentDidCatch) is recorded once, by the boundary. A call made while an error is being
 * recorded is not recorded. Stop restores console.error when it is still the wrapper; a wrapper
 * someone patched over stays in their chain and records nothing more.
 */
import type { RumRuntime } from "../contracts/runtime.ts";
import { DescribedError } from "./described.ts";
import { normalizeError } from "./normalize.ts";
import { wasRecorded } from "./record.ts";
import type { ErrorRecorder } from "./recorder.ts";

/** The console whose error method is watched. */
export interface ConsoleLike {
  error(...args: unknown[]): void;
}

function consoleError(args: readonly unknown[]): DescribedError {
  let first: ReturnType<typeof normalizeError> | undefined;
  const parts = args.map((a) => {
    if (a instanceof Error) {
      const n = normalizeError(a);
      first ??= n;
      return n.message;
    }
    try {
      return String(a);
    } catch {
      return "[object]";
    }
  });
  return new DescribedError(first?.type ?? "ConsoleError", parts.join(" "), first?.stack);
}

/** Records con.error calls through rec until the returned function is called. */
export function watchConsoleErrors(
  rt: RumRuntime,
  rec: ErrorRecorder,
  con: ConsoleLike,
  setTimeout: (cb: () => void, ms: number) => unknown,
): () => void {
  const original = con.error;
  let live = true;
  const wrapper = (...args: unknown[]): void => {
    try {
      if (!live) return;
      const logged = args.filter((a): a is object => typeof a === "object" && a !== null);
      // A console.error made while an error is being recorded is not recorded, deferred or not.
      if (rec.recording()) return;
      if (logged.length === 0) rec.record("console", consoleError(args));
      else if (!logged.some((a) => wasRecorded(rt, a))) {
        const at = rt.now();
        setTimeout(() => {
          if (live && !logged.some((a) => wasRecorded(rt, a))) rec.record("console", consoleError(args), at);
        }, 0);
      }
    } finally {
      original.apply(con, args);
    }
  };
  con.error = wrapper;
  return () => {
    live = false;
    if (con.error === wrapper) con.error = original;
  };
}
