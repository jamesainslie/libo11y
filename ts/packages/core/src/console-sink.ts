/**
 * The console sink: one line per log record, in Go slog's JSON or text format, written through the
 * Platform's writeConsoleLine and never through the console object, so console capture cannot loop.
 *
 * JSON lines carry the keys in Go's order: time, level, msg, then trace_id and span_id inside a valid
 * span context, then the attributes, with groups as nested objects. Strings are escaped as slog
 * escapes them (no HTML escaping, U+2028 and U+2029 escaped, invalid UTF-16 as U+FFFD). The time is
 * Go's RFC3339Nano, which trims trailing zeros. Text lines are logfmt with slog's quoting rules and
 * dotted group keys; their time has slog's fixed milliseconds.
 */
import { formatNumber } from "./canonical.ts";
import type { LogAttributes, LogLevel, LogValue } from "./log-values.ts";
import { base64Encode } from "./utf8.ts";

/** The console text of each level. */
export const LEVEL_TEXT: Readonly<Record<LogLevel, string>> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
  fatal: "FATAL",
};

/** One record as the console sink writes it. */
export interface ConsoleRecord {
  readonly time: Date;
  readonly level: LogLevel;
  readonly msg: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly attributes: LogAttributes;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function dateTime(t: Date): string {
  return (
    `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1, 2)}-${pad(t.getUTCDate(), 2)}` +
    `T${pad(t.getUTCHours(), 2)}:${pad(t.getUTCMinutes(), 2)}:${pad(t.getUTCSeconds(), 2)}`
  );
}

/** t in Go's time.RFC3339Nano layout, in UTC: the fraction drops its trailing zeros. */
export function rfc3339Nano(t: Date): string {
  const ms = t.getUTCMilliseconds();
  const frac = ms === 0 ? "" : `.${pad(ms, 3).replace(/0+$/, "")}`;
  return `${dateTime(t)}${frac}Z`;
}

/** t in slog's text layout, RFC3339 with fixed milliseconds, in UTC. */
export function rfc3339Millis(t: Date): string {
  return `${dateTime(t)}.${pad(t.getUTCMilliseconds(), 3)}Z`;
}

const HEX = "0123456789abcdef";

// jsonString escapes s as slog's appendEscapedJSONString does: encoding/json's rules with HTML
// escaping off.
function jsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + (s[i + 1] as string);
        i++;
      } else {
        out += "\\ufffd";
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      out += "\\ufffd";
      continue;
    }
    switch (c) {
      case 0x22:
        out += '\\"';
        continue;
      case 0x5c:
        out += "\\\\";
        continue;
      case 0x0a:
        out += "\\n";
        continue;
      case 0x0d:
        out += "\\r";
        continue;
      case 0x09:
        out += "\\t";
        continue;
      case 0x2028:
      case 0x2029:
        out += `\\u202${HEX[c & 0xf]}`;
        continue;
    }
    out += c < 0x20 ? `\\u00${HEX[c >> 4]}${HEX[c & 0xf]}` : s[i];
  }
  return `${out}"`;
}

function isGroup(v: unknown): v is { readonly [key: string]: LogValue } {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Uint8Array) &&
    !(v instanceof Error)
  );
}

function jsonNumber(n: number): string {
  if (Number.isNaN(n)) return '"NaN"';
  if (n === Number.POSITIVE_INFINITY) return '"+Inf"';
  if (n === Number.NEGATIVE_INFINITY) return '"-Inf"';
  // A safe integer is Go's int64; any other finite number encodes as encoding/json encodes a
  // float64, which is JavaScript's own shortest form.
  return Number.isSafeInteger(n) ? String(n === 0 ? 0 : n) : JSON.stringify(n);
}

function jsonValue(v: LogValue): string {
  switch (typeof v) {
    case "string":
      return jsonString(v);
    case "number":
      return jsonNumber(v);
    case "boolean":
      return v ? "true" : "false";
    case "bigint":
      return jsonString(v.toString());
    case "undefined":
      return "null";
  }
  if (v === null) return "null";
  if (v instanceof Uint8Array) return jsonString(base64Encode(v));
  if (v instanceof Error) return jsonString(String(v));
  if (Array.isArray(v)) return `[${v.map((e: LogValue) => jsonValue(e)).join(",")}]`;
  return `{${jsonMembers(v as { readonly [key: string]: LogValue })}}`;
}

function jsonMembers(group: { readonly [key: string]: LogValue }): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(group)) {
    if (v === undefined) continue;
    if (isGroup(v) && Object.keys(v).length === 0) continue; // slog elides empty groups
    parts.push(`${jsonString(k)}:${jsonValue(v)}`);
  }
  return parts.join(",");
}

/** The record as one slog JSONHandler line, without the trailing newline. */
export function formatJsonLine(rec: ConsoleRecord): string {
  let out = `{"time":"${rfc3339Nano(rec.time)}","level":"${LEVEL_TEXT[rec.level]}","msg":${jsonString(rec.msg)}`;
  if (rec.traceId !== undefined && rec.spanId !== undefined) {
    out += `,"trace_id":"${rec.traceId}","span_id":"${rec.spanId}"`;
  }
  const members = jsonMembers(rec.attributes);
  return `${out}${members === "" ? "" : `,${members}`}}`;
}

// isPrintable reports Go's unicode.IsPrint for one code point: letters, marks, numbers,
// punctuation, symbols and the ASCII space.
const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

function isPrint(ch: string, cp: number): boolean {
  if (cp < 0x80) return cp >= 0x20 && cp < 0x7f;
  return PRINTABLE.test(ch);
}

// needsQuoting is slog's: empty, or holding a space, '=', a character JSON would escape (except a
// backslash), or a non-ASCII character that is a space, unprintable or invalid.
function needsQuoting(s: string): boolean {
  if (s === "") return true;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      if (cp === 0x5c) continue;
      if (cp === 0x20 || cp === 0x3d || cp === 0x22 || cp < 0x20) return true;
      continue;
    }
    if (cp >= 0xd800 && cp <= 0xdfff) return true;
    if (!isPrint(ch, cp)) return true;
  }
  return false;
}

// strconvQuote is Go's strconv.Quote over the string's UTF-8 form.
function strconvQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    let cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    switch (cp) {
      case 0x22:
        out += '\\"';
        continue;
      case 0x5c:
        out += "\\\\";
        continue;
      case 0x07:
        out += "\\a";
        continue;
      case 0x08:
        out += "\\b";
        continue;
      case 0x0c:
        out += "\\f";
        continue;
      case 0x0a:
        out += "\\n";
        continue;
      case 0x0d:
        out += "\\r";
        continue;
      case 0x09:
        out += "\\t";
        continue;
      case 0x0b:
        out += "\\v";
        continue;
    }
    const c = String.fromCodePoint(cp);
    if (isPrint(c, cp)) out += c;
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${HEX[cp >> 4]}${HEX[cp & 0xf]}`;
    else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).padStart(8, "0")}`;
  }
  return `${out}"`;
}

/** s as slog's TextHandler writes a key or string value: bare, or strconv.Quote'd when needed. */
export function goQuoteText(s: string): string {
  return needsQuoting(s) ? strconvQuote(s) : s;
}

function textScalar(v: LogValue): string {
  switch (typeof v) {
    case "string":
      return v;
    case "number":
      return formatNumber(v);
    case "boolean":
      return v ? "true" : "false";
    case "bigint":
      return v.toString();
    case "undefined":
      return "<nil>";
  }
  if (v === null) return "<nil>";
  if (v instanceof Uint8Array) return base64Encode(v);
  if (v instanceof Error) return String(v);
  if (Array.isArray(v)) return `[${v.map((e: LogValue) => textScalar(e)).join(" ")}]`;
  return `map[${Object.entries(v as { readonly [key: string]: LogValue })
    .map(([k, e]) => `${k}:${textScalar(e)}`)
    .join(" ")}]`;
}

function textValue(v: LogValue): string {
  // slog writes numbers, booleans and nil bare; everything else is a string it may quote.
  if (
    typeof v === "number" ||
    typeof v === "boolean" ||
    typeof v === "bigint" ||
    v === null ||
    v === undefined
  )
    return textScalar(v);
  return goQuoteText(textScalar(v));
}

function textMembers(prefix: string, group: { readonly [key: string]: LogValue }, parts: string[]): void {
  for (const [k, v] of Object.entries(group)) {
    if (v === undefined) continue;
    const key = prefix === "" ? k : `${prefix}.${k}`;
    if (isGroup(v)) textMembers(key, v, parts);
    else parts.push(`${goQuoteText(key)}=${textValue(v)}`);
  }
}

/** The record as one slog TextHandler line, without the trailing newline. */
export function formatTextLine(rec: ConsoleRecord): string {
  const parts = [
    `time=${rfc3339Millis(rec.time)}`,
    `level=${LEVEL_TEXT[rec.level]}`,
    `msg=${goQuoteText(rec.msg)}`,
  ];
  if (rec.traceId !== undefined && rec.spanId !== undefined) {
    parts.push(`trace_id=${rec.traceId}`, `span_id=${rec.spanId}`);
  }
  textMembers("", rec.attributes, parts);
  return parts.join(" ");
}

/** Writes records as console lines. A write that throws propagates; the caller decides. */
export class ConsoleSink {
  private readonly format: (rec: ConsoleRecord) => string;
  private readonly writeLine: (line: string) => void;

  constructor(format: "json" | "text", writeLine: (line: string) => void) {
    this.format = format === "json" ? formatJsonLine : formatTextLine;
    this.writeLine = writeLine;
  }

  write(rec: ConsoleRecord): void {
    this.writeLine(this.format(rec));
  }
}
