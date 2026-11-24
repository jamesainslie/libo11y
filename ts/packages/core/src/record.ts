/**
 * Wide records: attributes accumulated over a request into one event, the canonical log line.
 * startRecord attaches a record to a context; currentRecord finds it, or returns a detached record
 * whose writes go nowhere, so call sites never check for undefined.
 *
 * JavaScript has one number type, so add and max work on any number: add sums onto an existing
 * number and max keeps the larger, and either replaces a value of another type. Go distinguishes
 * int64 for Add and float64 for Max.
 */
import { type Context, context, createContextKey } from "@opentelemetry/api";
import { lastWins } from "./events.ts";
import type { LogAttributes, LogValue } from "./log-values.ts";

/** What emitEvent needs: a Telemetry, or anything with its event method. */
export interface EventEmitter {
  event(name: string, attrs?: LogAttributes, ctx?: Context): void;
}

/** One request's wide event. */
export interface WideRecord {
  /** Records or overwrites attributes. A key keeps the position of its first insertion. */
  set(attrs: LogAttributes): void;
  /** Adds delta to the number at key, or sets it to delta. */
  add(key: string, delta: number): void;
  /** Keeps the larger of the number at key and value, or sets it to value. */
  max(key: string, value: number): void;
  /** A copy of the attributes, in insertion order. */
  snapshot(): LogAttributes;
  /** Emits the record as event name through telemetry; attrs replace accumulated keys. */
  emitEvent(telemetry: EventEmitter, name: string, attrs?: LogAttributes, ctx?: Context): void;
}

const RECORD_KEY: symbol = createContextKey("libo11y.record");

// The brand every core copy's records carry, so two copies of core in one process find each
// other's records where instanceof would not.
const BRAND: unique symbol = Symbol.for("libo11y.wide-record") as never;

function isWideRecord(value: unknown): value is WideRecord {
  return typeof value === "object" && value !== null && (value as { [BRAND]?: unknown })[BRAND] === true;
}

class AttachedRecord implements WideRecord {
  readonly [BRAND] = true;
  private readonly attrs: { [key: string]: LogValue } = {};

  set(attrs: LogAttributes): void {
    Object.assign(this.attrs, attrs);
  }

  add(key: string, delta: number): void {
    const current = this.attrs[key];
    this.attrs[key] = typeof current === "number" ? current + delta : delta;
  }

  max(key: string, value: number): void {
    const current = this.attrs[key];
    if (typeof current === "number" && current >= value) return;
    this.attrs[key] = value;
  }

  snapshot(): LogAttributes {
    return { ...this.attrs };
  }

  emitEvent(telemetry: EventEmitter, name: string, attrs?: LogAttributes, ctx?: Context): void {
    telemetry.event(name, lastWins(this.snapshot(), attrs ?? {}), ctx);
  }
}

/** Attaches a fresh record to ctx (default: the active context) and returns both. */
export function startRecord(ctx?: Context): { context: Context; record: WideRecord } {
  const record = new AttachedRecord();
  return { context: (ctx ?? context.active()).setValue(RECORD_KEY, record), record };
}

/** The record attached to ctx (default: the active context), or a detached one. Never undefined. */
export function currentRecord(ctx?: Context): WideRecord {
  const found = (ctx ?? context.active()).getValue(RECORD_KEY);
  return isWideRecord(found) ? found : new AttachedRecord();
}
