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
 * Nested Error values render as String(err).
 *
 * Nothing here throws into the caller, except on the strict path the startup canary takes. The
 * caller's attributes are read once, into data the pipeline owns, before anything judges or writes
 * them. A failure is reported to the pipeline's error handler and the pipeline fails closed: an
 * attribute that cannot be read or classified is dropped, a replacer that fails drops the record
 * rather than let it out unredacted, and a sink that fails loses its copy of the record.
 *
 * A report names the step, the class of the error and the attribute key. It never repeats the
 * error's message, which can quote the value that made the hook fail (internal/report.ts).
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
import { gateOpen } from "./gate.ts";
import {
  type AttributeNoun,
  failure,
  type Report,
  readInto,
  unreadable as unreadableAs,
} from "./internal/report.ts";
import { isError } from "./is-error.ts";
import type { LogAttributes, LogLevel, LogValue } from "./log-values.ts";
import { markClassified } from "./logs-processor.ts";
import type { AttrReplacer } from "./options.ts";
import type { RecordingGate } from "./platform.ts";
import type { SensitivityPolicy } from "./policy.ts";

/** The libo11y logger. fatal logs at FATAL and returns; it never exits. No method throws. */
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

const LOG: AttributeNoun = { one: "log attribute", all: "log attributes" };

function isGroup(v: unknown): v is { readonly [key: string]: LogValue } {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array) && !isError(v)
  );
}

function isPlain(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function unreadable(path: readonly string[], key: string, cause: unknown): Error {
  return unreadableAs(LOG, path, key, cause);
}

/** What a failing replacer throws through the walk, so the record is dropped whole. */
class ReplacerFailure extends Error {
  /** The dotted key of the attribute the replacer was given. */
  readonly key: string;

  constructor(key: string, cause: unknown) {
    super("o11y: attrReplacer failed", { cause });
    this.key = key;
  }
}

function exceptionAttrs(err: Error): MutableAttrs {
  const out: MutableAttrs = { "exception.type": err.name, "exception.message": err.message };
  if (typeof err.stack === "string") out["exception.stacktrace"] = err.stack;
  return out;
}

// buildAttributes drops the reserved correlation keys and undefined values from normalized
// attributes, and expands one Error into exception.*. An Error that cannot be read is dropped.
function buildAttributes(attrs: LogAttributes, err: Error | undefined, report: Report): MutableAttrs {
  const out: MutableAttrs = {};
  let expanded = err !== undefined;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "trace_id" || k === "span_id" || v === undefined) continue;
    if (isError(v)) {
      const expand = !expanded;
      expanded = true;
      try {
        if (expand) Object.assign(out, exceptionAttrs(v));
        else out[k] = String(v);
      } catch (cause) {
        report(unreadable([], k, cause));
      }
      continue;
    }
    out[k] = v;
  }
  if (err !== undefined) {
    try {
      Object.assign(out, exceptionAttrs(err));
    } catch (cause) {
      report(unreadable([], "exception", cause));
    }
  }
  return out;
}

const MAX_GROUP_DEPTH = 16;

/** The state of one record's walk over its attributes. */
interface Walk {
  readonly report: Report;
  /** The groups being walked, outermost first. */
  readonly onPath: object[];
  /** The copy made of each array and plain object found inside an array. */
  copies: Map<object, unknown> | undefined;
}

// inert returns value as data that nothing can make throw or change later. Scalars, bytes, errors
// and class instances pass as they are. An array or a plain object is copied member by member, each
// read once, so the policy and the sinks see one reading. A cycle or a shared member keeps its
// shape in the copy, so the policy bounds the copy exactly as it would the original. It throws
// what reading or classifying a member throws, and the caller drops the attribute.
function inert(value: unknown, walk: Walk): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Uint8Array || isError(value)) return value;
  const array = Array.isArray(value);
  if (!array && !isPlain(value)) return value;
  walk.copies ??= new Map();
  const copied = walk.copies.get(value);
  if (copied !== undefined) return copied;
  // A copy maps to itself, so the replacer's pass does not copy what the first pass already did.
  const out: unknown[] | { [key: string]: unknown } = array ? [] : {};
  walk.copies.set(value, out);
  walk.copies.set(out, out);
  if (Array.isArray(out)) {
    const source = value as readonly unknown[];
    for (let i = 0; i < source.length; i++) out.push(inert(source[i], walk));
  } else {
    for (const k of Object.keys(value)) out[k] = inert((value as { [key: string]: unknown })[k], walk);
  }
  return out;
}

// normalize shapes attributes as slog does: an empty-keyed group is inlined into its parent, an
// empty group is elided, and a leaf with an empty key or an undefined value is dropped. With a
// replacer it also applies the replacer to every leaf, with the leaf's group path. Cycles and
// groups past depth 16 are dropped, as the policy would drop them. It always runs, so a member of
// an empty-keyed group reaches the policy on its parent's path.
//
// It is also where the caller's values are read: each member once, into a fresh group. A member
// that cannot be read or classified is dropped and reported. A replacer that fails throws
// ReplacerFailure, which drops the record.
function normalize(
  group: { readonly [key: string]: LogValue },
  replacer: AttrReplacer | undefined,
  path: readonly string[],
  walk: Walk,
): MutableAttrs {
  const out: MutableAttrs = {};
  let keys: string[];
  try {
    keys = Object.keys(group);
  } catch (err) {
    walk.report(unreadable(path, "", err));
    return out;
  }
  for (const k of keys) {
    let v: LogValue;
    let nested: boolean;
    try {
      v = group[k];
      if (v === undefined) continue;
      nested = isGroup(v);
      if (!nested) v = inert(v, walk) as LogValue;
    } catch (err) {
      walk.report(unreadable(path, k, err));
      continue;
    }
    if (nested) {
      const inner = v as { readonly [key: string]: LogValue };
      if (walk.onPath.includes(inner) || walk.onPath.length >= MAX_GROUP_DEPTH) continue;
      walk.onPath.push(inner);
      const members = normalize(inner, replacer, k === "" ? path : [...path, k], walk);
      walk.onPath.pop();
      if (Object.keys(members).length === 0) continue;
      if (k === "") Object.assign(out, members);
      else out[k] = members;
      continue;
    }
    if (k === "") continue;
    if (replacer === undefined) {
      out[k] = v;
      continue;
    }
    let key: string;
    let replaced: unknown;
    try {
      const r = replacer(k, v, [...path]);
      if (r === undefined || r[0] === "" || r[1] === undefined) continue;
      key = r[0];
      replaced = r[1];
    } catch (err) {
      throw new ReplacerFailure([...path, k].join("."), err);
    }
    try {
      out[key] = inert(replaced, walk) as LogValue;
    } catch (err) {
      walk.report(unreadable(path, key, err));
    }
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
  /** The platform's recording gate. While it is closed the OTLP leg is skipped; the console still writes. */
  readonly gate?: RecordingGate;
  /** The clock. Default: new Date(). */
  readonly now?: () => Date;
  /**
   * Receives what the pipeline dropped instead of throwing: an attribute it could not read, a record
   * whose replacer failed, a sink that failed. It must not log through this pipeline. Default: none.
   */
  readonly onError?: (err: unknown) => void;
}

/** How one record is emitted. */
export interface EmitOptions {
  /** The record's context. Default: the active context. */
  readonly ctx?: Context;
  /** The Error argument of error() and fatal(). */
  readonly error?: Error;
  /** The child bindings, which come before the record's attributes. */
  readonly bound?: LogAttributes;
  /** Rethrow replacer and sink errors instead of reporting them: the startup canary's path. */
  readonly strict?: boolean;
  /** Write to the console sink only, as o11y.telemetry.dropped does at shutdown. */
  readonly consoleOnly?: boolean;
  /** Write to the OTLP leg only, as the deferred startup canary does when the gate first opens. */
  readonly otlpOnly?: boolean;
  /** Emit under forceEmit(ctx), so the level gate never drops the record. */
  readonly force?: boolean;
  /** Reshapes the attributes once they have been read, before they are normalized, as events do. */
  readonly shape?: (attrs: LogAttributes) => LogAttributes;
}

/** What one sink threw for one record. */
interface SinkFailure {
  readonly sink: "the console" | "OTLP";
  readonly error: unknown;
}

/** The fan-out behind every libo11y logger. */
export class LogPipeline {
  private readonly level: LogLevel;
  private readonly policy: SensitivityPolicy;
  private readonly replacer: AttrReplacer | undefined;
  private readonly console: ConsoleSink | undefined;
  private readonly otlp: LogsApiLogger | undefined;
  private readonly gate: RecordingGate | undefined;
  private readonly now: () => Date;
  private readonly onError: ((err: unknown) => void) | undefined;
  private readonly report: Report;

  constructor(opts: LogPipelineOptions) {
    this.level = opts.level;
    this.policy = opts.policy;
    this.replacer = opts.replacer;
    this.console = opts.console;
    this.otlp = opts.otlp;
    this.gate = opts.gate;
    this.now = opts.now ?? (() => new Date());
    this.onError = opts.onError;
    this.report = (err) => {
      try {
        this.onError?.(err);
      } catch {
        // The handler is the last resort; nothing is left to report to.
      }
    };
  }

  /** Reports whether a record at level under ctx passes the gate. */
  enabled(level: LogLevel, ctx: Context): boolean {
    return isForced(ctx) || RANK[level] >= RANK[this.level];
  }

  /** bound with attrs after it, as a child logger binds them. Never throws. */
  bind(bound: LogAttributes, attrs: unknown): LogAttributes {
    const out: MutableAttrs = { ...bound };
    readInto(out, attrs, LOG, this.report);
    return out;
  }

  /**
   * Emits one record to every sink. It throws only when strict, and then what the replacer or a
   * sink threw. Otherwise a failure is reported to onError and the record, or the failing sink's
   * copy of it, is dropped.
   */
  emit(level: LogLevel, msg: string, attrs: LogAttributes | undefined, opts: EmitOptions = {}): void {
    const strict = opts.strict === true;
    let failures: SinkFailure[];
    try {
      failures = this.write(level, msg, attrs, opts);
    } catch (err) {
      const replacer = err instanceof ReplacerFailure ? err : undefined;
      if (strict) throw replacer === undefined ? err : replacer.cause;
      this.report(
        replacer === undefined
          ? failure(`o11y: a ${LEVEL_TEXT[level]} log record is dropped`, err)
          : failure(
              `o11y: attrReplacer failed on ${JSON.stringify(replacer.key)}, the ${LEVEL_TEXT[level]} record is dropped`,
              replacer.cause,
            ),
      );
      return;
    }
    if (failures.length === 0) return;
    if (strict) {
      const errors = failures.map((f) => f.error);
      throw errors.length === 1 ? errors[0] : new AggregateError(errors, "o11y: log sinks failed");
    }
    for (const f of failures) {
      this.report(failure(`o11y: writing a log record to ${f.sink} failed`, f.error));
    }
  }

  // write runs the pipeline for one record and returns what each failing sink threw.
  private write(
    level: LogLevel,
    msg: string,
    attrs: LogAttributes | undefined,
    opts: EmitOptions,
  ): SinkFailure[] {
    let ctx = opts.ctx ?? context.active();
    if (opts.force === true) ctx = forceEmit(ctx);
    if (!this.enabled(level, ctx)) return [];
    const bound = opts.bound ?? {};
    let merged: LogAttributes = attrs === undefined ? bound : this.bind(bound, attrs);
    if (opts.shape !== undefined) merged = opts.shape(merged);
    const walk: Walk = { report: this.report, onPath: [], copies: undefined };
    let built: LogAttributes = buildAttributes(
      normalize(merged, undefined, [], walk),
      opts.error,
      this.report,
    );
    if (this.replacer !== undefined) built = normalize(built, this.replacer, [], walk);
    const time = this.now();
    const failures: SinkFailure[] = [];

    if (this.console !== undefined && opts.otlpOnly !== true) {
      try {
        const sc = trace.getSpanContext(ctx);
        const ids =
          sc !== undefined && isSpanContextValid(sc) ? { traceId: sc.traceId, spanId: sc.spanId } : {};
        this.console.write({ time, level, msg, ...ids, attributes: this.policy.logAttributes(built) });
      } catch (error) {
        failures.push({ sink: "the console", error });
      }
    }
    if (this.otlp !== undefined && opts.consoleOnly !== true && gateOpen(this.gate)) {
      try {
        this.otlp.emit({
          timestamp: time,
          severityNumber: SEVERITY_NUMBER[level],
          severityText: LEVEL_TEXT[level],
          body: msg,
          attributes: otlpMap(this.policy.logAttributes(built)) as Record<string, never>,
          context: markClassified(ctx),
        });
      } catch (error) {
        failures.push({ sink: "OTLP", error });
      }
    }
    return failures;
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
    this.logWith("error", msg, attrsOrError);
  }

  fatal(msg: string, attrsOrError?: LogAttributes | Error): void {
    this.logWith("fatal", msg, attrsOrError);
  }

  child(attrs: LogAttributes): Logger {
    return new CoreLogger(this.pipeline, this.pipeline.bind(this.bound, attrs));
  }

  private logWith(level: LogLevel, msg: string, attrsOrError: LogAttributes | Error | undefined): void {
    let error: Error | undefined;
    try {
      if (isError(attrsOrError)) error = attrsOrError;
    } catch {
      // Whatever cannot even be tested is not an Error: emit reads it as attributes and reports it.
    }
    if (error !== undefined) this.log(level, msg, undefined, error);
    else this.log(level, msg, attrsOrError as LogAttributes | undefined);
  }
}
