/**
 * The libo11y logger: six levels fanned out to the console sink and the OTLP leg.
 *
 * Each record goes through one pipeline, in Go's order:
 * 1. the level gate, which a forced context (forceEmit) bypasses;
 * 2. the attributes: the child bindings, then the record's. Top-level trace_id and span_id are
 *    dropped, and the Error argument, or else the first top-level Error value, expands to
 *    exception.type, exception.message and exception.stacktrace;
 * 3. the user replacer, once per leaf with its group path;
 * 4. per sink, the sensitivity policy (which counts once per sink), then the write.
 *
 * The console line carries trace_id and span_id inside a valid span context. The OTLP leg emits
 * through the logs API with the context marked classified, so the bridge processor leaves it alone.
 * Nested Error values render as String(err). A failing sink is swallowed, except on the strict path
 * the startup canary takes.
 */
import {
  type Context,
  context,
  createContextKey,
  isSpanContextValid,
  type Logger as LogsApiLogger,
  type SeverityNumber,
  trace,
} from "@opentelemetry/api";
import { type ConsoleSink, LEVEL_TEXT } from "./console-sink.ts";
import { isError } from "./is-error.ts";
import type { LogAttributes, LogLevel, LogValue } from "./log-values.ts";
import { markClassified } from "./logs-processor.ts";
import type { AttrReplacer } from "./options.ts";
import type { SensitivityPolicy } from "./policy.ts";

/** The libo11y logger. fatal logs at FATAL and returns; it never exits. */
export interface Logger {
  trace(msg: string, attrs?: LogAttributes): void;
  debug(msg: string, attrs?: LogAttributes): void;
  info(msg: string, attrs?: LogAttributes): void;
  warn(msg: string, attrs?: LogAttributes): void;
  error(msg: string, attrsOrError?: LogAttributes | Error): void;
  fatal(msg: string, attrsOrError?: LogAttributes | Error): void;
  /** A logger whose records start with attrs. */
  child(attrs: LogAttributes): Logger;
}

/** The OTLP severity number of each level. */
export const SEVERITY_NUMBER: Readonly<Record<LogLevel, SeverityNumber>> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

const RANK: Readonly<Record<LogLevel, number>> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

const FORCE_KEY: symbol = createContextKey("libo11y.log.force");

/**
 * Returns ctx (default: the active context) marked so records emitted under it bypass the level
 * gate. Classification, the replacer and correlation still apply.
 */
export function forceEmit(ctx?: Context): Context {
  return (ctx ?? context.active()).setValue(FORCE_KEY, true);
}

/** Reports whether ctx carries the forceEmit mark. */
export function isForced(ctx: Context): boolean {
  return ctx.getValue(FORCE_KEY) === true;
}

type MutableAttrs = { [key: string]: LogValue };

function isGroup(v: unknown): v is { readonly [key: string]: LogValue } {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array) && !isError(v)
  );
}

function exceptionAttrs(err: Error): MutableAttrs {
  const out: MutableAttrs = { "exception.type": err.name, "exception.message": err.message };
  if (typeof err.stack === "string") out["exception.stacktrace"] = err.stack;
  return out;
}

// buildAttributes drops the reserved correlation keys and undefined values from normalized
// attributes, and expands one Error into exception.*.
function buildAttributes(attrs: LogAttributes, err: Error | undefined): MutableAttrs {
  const out: MutableAttrs = {};
  let expanded = err !== undefined;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "trace_id" || k === "span_id" || v === undefined) continue;
    if (isError(v)) {
      if (!expanded) {
        expanded = true;
        Object.assign(out, exceptionAttrs(v));
      } else {
        out[k] = String(v);
      }
      continue;
    }
    out[k] = v;
  }
  if (err !== undefined) Object.assign(out, exceptionAttrs(err));
  return out;
}

const MAX_GROUP_DEPTH = 16;

// normalize shapes attributes as slog does: an empty-keyed group is inlined into its parent, an
// empty group is elided, and a leaf with an empty key or an undefined value is dropped. With a
// replacer it also applies the replacer to every leaf, with the leaf's group path. Cycles and
// groups past depth 16 are dropped, as the policy would drop them. It always runs, so a member of
// an empty-keyed group reaches the policy on its parent's path.
function normalize(
  group: { readonly [key: string]: LogValue },
  replacer: AttrReplacer | undefined,
  path: readonly string[],
  onPath: object[],
): MutableAttrs {
  const out: MutableAttrs = {};
  for (const [k, v] of Object.entries(group)) {
    if (v === undefined) continue;
    if (isGroup(v)) {
      if (onPath.includes(v) || onPath.length >= MAX_GROUP_DEPTH) continue;
      onPath.push(v);
      const inner = normalize(v, replacer, k === "" ? path : [...path, k], onPath);
      onPath.pop();
      if (Object.keys(inner).length === 0) continue;
      if (k === "") Object.assign(out, inner);
      else out[k] = inner;
      continue;
    }
    if (k === "") continue;
    if (replacer === undefined) {
      out[k] = v;
      continue;
    }
    const r = replacer(k, v, [...path]);
    if (r === undefined || r[0] === "" || r[1] === undefined) continue;
    out[r[0]] = r[1] as LogValue;
  }
  return out;
}

// otlpValue turns a classified log value into a logs API AnyValue: bigints and nested errors become
// strings, groups become maps, and empty groups are elided.
function otlpValue(v: LogValue): unknown {
  if (typeof v === "bigint") return v.toString();
  if (isError(v)) return String(v);
  if (Array.isArray(v)) return v.map((e: LogValue) => otlpValue(e));
  if (isGroup(v)) return otlpMap(v);
  return v;
}

function otlpMap(group: { readonly [key: string]: LogValue }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(group)) {
    if (v === undefined) continue;
    if (isGroup(v) && Object.keys(v).length === 0) continue;
    out[k] = otlpValue(v);
  }
  return out;
}

/** What LogPipeline needs. */
export interface LogPipelineOptions {
  /** The lowest level emitted unless forced. */
  readonly level: LogLevel;
  readonly policy: SensitivityPolicy;
  readonly replacer?: AttrReplacer;
  /** The console sink, absent when the console is off. */
  readonly console?: ConsoleSink;
  /** The OTLP leg: a logs API Logger from the libo11y LoggerProvider, absent when logs are off. */
  readonly otlp?: LogsApiLogger;
  /** The clock. Default: new Date(). */
  readonly now?: () => Date;
}

/** How one record is emitted. */
export interface EmitOptions {
  /** The record's context. Default: the active context. */
  readonly ctx?: Context;
  /** The Error argument of error() and fatal(). */
  readonly error?: Error;
  /** The child bindings, which come before the record's attributes. */
  readonly bound?: LogAttributes;
  /** Rethrow sink errors instead of swallowing them: the startup canary's path. */
  readonly strict?: boolean;
  /** Write to the console sink only, as o11y.telemetry.dropped does at shutdown. */
  readonly consoleOnly?: boolean;
}

/** The fan-out behind every libo11y logger. */
export class LogPipeline {
  private readonly level: LogLevel;
  private readonly policy: SensitivityPolicy;
  private readonly replacer: AttrReplacer | undefined;
  private readonly console: ConsoleSink | undefined;
  private readonly otlp: LogsApiLogger | undefined;
  private readonly now: () => Date;

  constructor(opts: LogPipelineOptions) {
    this.level = opts.level;
    this.policy = opts.policy;
    this.replacer = opts.replacer;
    this.console = opts.console;
    this.otlp = opts.otlp;
    this.now = opts.now ?? (() => new Date());
  }

  /** Reports whether a record at level under ctx passes the gate. */
  enabled(level: LogLevel, ctx: Context): boolean {
    return isForced(ctx) || RANK[level] >= RANK[this.level];
  }

  /** Emits one record to every sink. Throws only when strict and a sink failed. */
  emit(level: LogLevel, msg: string, attrs: LogAttributes | undefined, opts: EmitOptions = {}): void {
    const ctx = opts.ctx ?? context.active();
    if (!this.enabled(level, ctx)) return;
    const bound = opts.bound ?? {};
    const merged: LogAttributes = attrs === undefined ? bound : { ...bound, ...attrs };
    let built: LogAttributes = buildAttributes(normalize(merged, undefined, [], []), opts.error);
    if (this.replacer !== undefined) built = normalize(built, this.replacer, [], []);
    const time = this.now();
    const failures: unknown[] = [];

    if (this.console !== undefined) {
      try {
        const sc = trace.getSpanContext(ctx);
        const ids =
          sc !== undefined && isSpanContextValid(sc) ? { traceId: sc.traceId, spanId: sc.spanId } : {};
        this.console.write({ time, level, msg, ...ids, attributes: this.policy.logAttributes(built) });
      } catch (err) {
        failures.push(err);
      }
    }
    if (this.otlp !== undefined && opts.consoleOnly !== true) {
      try {
        this.otlp.emit({
          timestamp: time,
          severityNumber: SEVERITY_NUMBER[level],
          severityText: LEVEL_TEXT[level],
          body: msg,
          attributes: otlpMap(this.policy.logAttributes(built)) as Record<string, never>,
          context: markClassified(ctx),
        });
      } catch (err) {
        failures.push(err);
      }
    }
    if (opts.strict === true && failures.length > 0) {
      throw failures.length === 1 ? failures[0] : new AggregateError(failures, "o11y: log sinks failed");
    }
  }
}

/** The Logger over a LogPipeline. */
export class CoreLogger implements Logger {
  private readonly pipeline: LogPipeline;
  private readonly bound: LogAttributes;

  constructor(pipeline: LogPipeline, bound: LogAttributes = {}) {
    this.pipeline = pipeline;
    this.bound = bound;
  }

  /** Emits at level with this logger's bindings, the record's attributes and an optional Error. */
  log(level: LogLevel, msg: string, attrs?: LogAttributes, error?: Error, ctx?: Context): void {
    this.pipeline.emit(level, msg, attrs, {
      bound: this.bound,
      ...(error === undefined ? {} : { error }),
      ...(ctx === undefined ? {} : { ctx }),
    });
  }

  trace(msg: string, attrs?: LogAttributes): void {
    this.log("trace", msg, attrs);
  }

  debug(msg: string, attrs?: LogAttributes): void {
    this.log("debug", msg, attrs);
  }

  info(msg: string, attrs?: LogAttributes): void {
    this.log("info", msg, attrs);
  }

  warn(msg: string, attrs?: LogAttributes): void {
    this.log("warn", msg, attrs);
  }

  error(msg: string, attrsOrError?: LogAttributes | Error): void {
    if (isError(attrsOrError)) this.log("error", msg, undefined, attrsOrError);
    else this.log("error", msg, attrsOrError);
  }

  fatal(msg: string, attrsOrError?: LogAttributes | Error): void {
    if (isError(attrsOrError)) this.log("fatal", msg, undefined, attrsOrError);
    else this.log("fatal", msg, attrsOrError);
  }

  child(attrs: LogAttributes): Logger {
    return new CoreLogger(this.pipeline, { ...this.bound, ...attrs });
  }
}
