/**
 * Console capture: routes log, info, warn, error, debug and trace on a console object into the
 * libo11y logger. log and info map to info; the others to the level of the same name. Each record
 * carries o11y.log.source=console, and the first Error argument expands to exception.*.
 *
 * A captured call never reaches the original method, because the console sink prints the record
 * through the Platform's writeConsoleLine. A console call made while a capture is in progress, such
 * as one from inside a sink or an exporter, goes to the original method instead, so capture cannot
 * recurse.
 *
 * The message is formatted like util.format, without Node's inspect: %s, %d, %i, %f, %j, %o, %O, %c
 * and %% substitute, the remaining arguments join with a space, objects render as JSON with cycles
 * cut to "[Circular]", and errors as String(err).
 */
import { ATTR_LOG_SOURCE, LOG_SOURCE_VALUE_CONSOLE } from "@libo11y/spec";
import { isError } from "./is-error.ts";
import type { LogLevel } from "./log-values.ts";
import type { CoreLogger } from "./logger.ts";
import type { PlatformConsole } from "./platform.ts";

type Method = (...args: unknown[]) => void;

const LEVELS: Readonly<Record<keyof PlatformConsole, LogLevel>> = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
  trace: "trace",
};

function safeJson(value: unknown): string {
  const ancestors: unknown[] = [];
  try {
    const out = JSON.stringify(value, function (this: unknown, _key: string, v: unknown): unknown {
      if (typeof v === "bigint") return `${v}n`;
      if (isError(v)) return String(v);
      if (typeof v !== "object" || v === null) return v;
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(v)) return "[Circular]";
      ancestors.push(v);
      return v;
    });
    return out ?? String(value);
  } catch {
    return String(value);
  }
}

function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (isError(value)) return String(value);
  if (typeof value === "object" && value !== null) return safeJson(value);
  return String(value);
}

function numeric(value: unknown, parse: (v: unknown) => number): string {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol") return "NaN";
  return String(parse(value));
}

/** Formats console arguments as util.format does, within the limits above. */
export function formatConsoleArgs(args: readonly unknown[]): string {
  if (args.length === 0) return "";
  const [first, ...rest] = args;
  if (typeof first !== "string") return args.map(render).join(" ");
  let i = 0;
  const msg = first.replace(/%([sdifjoOc%])/g, (match, directive: string) => {
    if (directive === "%") return "%";
    if (i >= rest.length) return match;
    const arg = rest[i++];
    switch (directive) {
      case "s":
        return render(arg);
      case "d":
        return numeric(arg, (v) => (typeof v === "object" && v !== null ? Number.NaN : Number(v)));
      case "i":
        return numeric(arg, (v) => Number.parseInt(String(v), 10));
      case "f":
        return numeric(arg, (v) => Number.parseFloat(String(v)));
      case "j":
      case "o":
      case "O":
        return safeJson(arg);
      default:
        return ""; // %c consumes a CSS argument and prints nothing
    }
  });
  const tail = rest.slice(i).map(render);
  return tail.length === 0 ? msg : `${msg} ${tail.join(" ")}`;
}

/**
 * Patches target's six methods to log through logger, and returns the function that restores them.
 * Restoring twice is harmless. A method another capture has wrapped since is left in place; this
 * capture's wrapper then passes straight through to the method it saved, so captures can be
 * restored in any order.
 */
export function captureConsole(target: PlatformConsole, logger: CoreLogger): () => void {
  const saved = new Map<keyof PlatformConsole, { original: Method; wrapper: Method }>();
  let capturing = false;
  let active = true;
  for (const method of Object.keys(LEVELS) as (keyof PlatformConsole)[]) {
    const original = target[method];
    const level = LEVELS[method];
    const wrapper = (...args: unknown[]): void => {
      if (!active || capturing) {
        original.apply(target, args);
        return;
      }
      capturing = true;
      try {
        const error = args.find(isError);
        logger.log(level, formatConsoleArgs(args), { [ATTR_LOG_SOURCE]: LOG_SOURCE_VALUE_CONSOLE }, error);
      } catch {
        // A failing sink must not break the caller's console call.
      } finally {
        capturing = false;
      }
    };
    saved.set(method, { original, wrapper });
    target[method] = wrapper;
  }
  return () => {
    if (!active) return;
    active = false;
    for (const [method, { original, wrapper }] of saved) {
      if (target[method] === wrapper) target[method] = original;
    }
  };
}
