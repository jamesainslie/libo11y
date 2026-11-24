/**
 * The canonical rendering of a value, the input to the PII token (conformance/README.md, "pii-hash").
 * It reproduces Go's: scalars as text, floats in strconv's shortest 'g' form, bytes as base64, and
 * composites as JSON of their members' canonical forms, with map keys in UTF-8 byte order and strings
 * escaped as Go's encoding/json escapes them. The walk is bounded by depth, a node budget and cycles.
 */

import { isError } from "./is-error.ts";
import { base64Encode } from "./utf8.ts";

/** The deepest node the walk renders; the root is depth 0. */
export const MAX_DEPTH = 16;
/** The nodes one walk may visit. */
export const WALK_BUDGET = 2048;
/** What stands in for a part of a value the walk does not render. */
export const TRUNCATED = "truncated";

type CanonicalNode = string | CanonicalNode[] | { readonly entries: readonly [string, CanonicalNode][] };

/** Orders strings by code point, which is UTF-8 byte order. Array.prototype.sort compares UTF-16 units. */
export function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const d = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
}

/** Formats a float as Go's strconv.FormatFloat(f, 'g', -1, 64). */
export function formatGoFloat(f: number): string {
  if (Number.isNaN(f)) return "NaN";
  if (f === Number.POSITIVE_INFINITY) return "+Inf";
  if (f === Number.NEGATIVE_INFINITY) return "-Inf";
  if (f === 0) return Object.is(f, -0) ? "-0" : "0";
  // toExponential() with no argument gives the shortest digits that round-trip, as strconv's
  // shortest mode does: "d.ddde[+-]x".
  const [mantissa = "", exponent = "0"] = Math.abs(f).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exp = Number.parseInt(exponent, 10);
  const sign = f < 0 ? "-" : "";
  // With shortest precision strconv uses %e when the exponent is below -4 or at least 6.
  if (exp < -4 || exp >= 6) {
    const frac = digits.length > 1 ? `.${digits.slice(1)}` : "";
    const e = Math.abs(exp).toString().padStart(2, "0");
    return `${sign}${digits[0]}${frac}e${exp < 0 ? "-" : "+"}${e}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  if (digits.length <= exp + 1) return `${sign}${digits}${"0".repeat(exp + 1 - digits.length)}`;
  return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
}

/** Renders a number: a safe integer as Go renders an int64, any other number as a float64. */
export function formatNumber(n: number): string {
  return Number.isSafeInteger(n) ? String(n === 0 ? 0 : n) : formatGoFloat(n);
}

function isPlainObject(x: object): x is Record<string, unknown> {
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

class Walk {
  private budget: number;
  private readonly onPath: object[] = [];
  private readonly bounded: boolean;

  constructor(bounded: boolean) {
    this.bounded = bounded;
    this.budget = WALK_BUDGET;
  }

  node(x: unknown, depth: number): CanonicalNode {
    if (this.bounded && (depth > MAX_DEPTH || --this.budget < 0)) return TRUNCATED;
    switch (typeof x) {
      case "string":
        return x;
      case "number":
        return formatNumber(x);
      case "bigint":
        return x.toString();
      case "boolean":
        return x ? "true" : "false";
      case "undefined":
        return "<nil>";
      case "object":
        break;
      default:
        return String(x);
    }
    if (x === null) return "<nil>";
    if (x instanceof Uint8Array) return base64Encode(x);
    if (isError(x)) return String(x);
    const isArray = Array.isArray(x);
    if (!isArray && !isPlainObject(x)) return String(x);
    if (this.onPath.includes(x)) return TRUNCATED;
    this.onPath.push(x);
    try {
      if (isArray) return x.map((e) => this.node(e, depth + 1));
      const keys = Object.keys(x).sort(compareCodePoints);
      return { entries: keys.map((k) => [k, this.node(x[k], depth + 1)] as [string, CanonicalNode]) };
    } finally {
      this.onPath.pop();
    }
  }
}

const HEX = "0123456789abcdef";

// quote encodes s as Go's encoding/json does with HTML escaping on. A lone surrogate becomes U+FFFD,
// which is what its UTF-8 encoding carries.
function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    switch (ch) {
      case '"':
        out += '\\"';
        continue;
      case "\\":
        out += "\\\\";
        continue;
      case "\b":
        out += "\\b";
        continue;
      case "\f":
        out += "\\f";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\r":
        out += "\\r";
        continue;
      case "\t":
        out += "\\t";
        continue;
      case " ":
      case " ":
        out += `\\u202${HEX[c & 0xf]}`;
        continue;
    }
    if (c < 0x20 || ch === "<" || ch === ">" || ch === "&") {
      out += `\\u00${HEX[c >> 4]}${HEX[c & 0xf]}`;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      out += "�";
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

function encode(n: CanonicalNode): string {
  if (typeof n === "string") return quote(n);
  if (Array.isArray(n)) return `[${n.map(encode).join(",")}]`;
  return `{${n.entries.map(([k, v]) => `${quote(k)}:${encode(v)}`).join(",")}}`;
}

function render(value: unknown, bounded: boolean): string {
  const node = new Walk(bounded).node(value, 0);
  return typeof node === "string" ? node : encode(node);
}

/**
 * Renders value canonically, bounded as Go bounds a log value: past depth 16, on a cycle, or once
 * 2048 nodes are spent, the rest renders as "truncated".
 */
export function renderCanonical(value: unknown): string {
  return render(value, true);
}

/**
 * Renders an attribute value canonically without the depth and budget bounds, as Go renders an OTel
 * attribute value. Cycles, which an OTel attribute cannot hold, still render as "truncated".
 */
export function renderCanonicalAttribute(value: unknown): string {
  return render(value, false);
}
