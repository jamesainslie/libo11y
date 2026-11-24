/**
 * Ports of the gopkg.in/yaml.v3 behaviours parseAppRegistry must reproduce where the `yaml` library,
 * which follows YAML 1.2, differs: the characters the reader accepts, the double-quoted escapes the
 * scanner accepts, and how an explicitly tagged scalar resolves. Internal to @libo11y/spec.
 */

/** A problem yaml.v3 reports as a fatal error, which Go's conformance cases name `syntax`. */
export class YamlSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YamlSyntaxError";
  }
}

// yaml.v3's reader accepts tab, line feed, carriage return, printable ASCII, NEL, and the BMP and
// astral ranges except surrogates, U+FFFE and U+FFFF. Anything else is "control characters are not
// allowed". With the u flag, a lone surrogate in the string matches too.
const INVALID_CHARACTER = /[^\t\n\r\u{20}-\u{7e}\u{85}\u{a0}-\u{d7ff}\u{e000}-\u{fffd}\u{10000}-\u{10ffff}]/u;

/** Throws YamlSyntaxError when text holds a character yaml.v3's reader rejects. */
export function checkCharacters(text: string): void {
  const bad = INVALID_CHARACTER.exec(text);
  if (bad !== null) {
    const cp = bad[0].codePointAt(0) ?? 0;
    throw new YamlSyntaxError(
      `control characters are not allowed: U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
    );
  }
}

const SIMPLE_ESCAPES: ReadonlySet<string> = new Set([
  "0",
  "a",
  "b",
  "t",
  "\t",
  "n",
  "v",
  "f",
  "r",
  "e",
  " ",
  '"',
  "'",
  "\\",
  "N",
  "_",
  "L",
  "P",
]);
const LINE_BREAKS: ReadonlySet<string> = new Set(["\n", "\r", "\u0085", " ", " "]);
const HEX_LENGTH: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };
const HEX = /^[0-9a-fA-F]+$/;

/**
 * Checks the escapes in a double-quoted scalar's source, quotes included, against yaml.v3's scanner, and
 * returns the offsets within raw of every `\'`. yaml.v3 accepts `\'` and the `yaml` library, following
 * YAML 1.2, rejects it. YAML 1.2's `\/` is the reverse. Throws YamlSyntaxError on an escape yaml.v3
 * rejects.
 */
export function scanEscapes(raw: string): number[] {
  const quotes: number[] = [];
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i] !== "\\") continue;
    const c = raw[i + 1] ?? "";
    if (LINE_BREAKS.has(c) || SIMPLE_ESCAPES.has(c)) {
      if (c === "'") quotes.push(i);
      i++;
      continue;
    }
    const length = HEX_LENGTH[c];
    if (length === undefined)
      throw new YamlSyntaxError(`found unknown escape character ${JSON.stringify(c)}`);
    const hex = raw.slice(i + 2, i + 2 + length);
    if (hex.length !== length || !HEX.test(hex)) {
      throw new YamlSyntaxError("did not find expected hexdecimal number");
    }
    const value = Number.parseInt(hex, 16);
    if ((value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) {
      throw new YamlSyntaxError("found invalid Unicode character escape code");
    }
    i += 1 + length;
  }
  return quotes;
}

const LONG_TAG_PREFIX = "tag:yaml.org,2002:";

/** yaml.v3's shortTag: `tag:yaml.org,2002:int` becomes `!!int`. An absent tag is "". */
export function shortTag(tag: string | undefined): string {
  if (tag === undefined) return "";
  return tag.startsWith(LONG_TAG_PREFIX) ? `!!${tag.slice(LONG_TAG_PREFIX.length)}` : tag;
}

const NULL = "!!null";
const BOOL = "!!bool";
const STR = "!!str";
const INT = "!!int";
const FLOAT = "!!float";
const TIMESTAMP = "!!timestamp";
const BINARY = "!!binary";
const MERGE = "!!merge";
const RESOLVABLE: ReadonlySet<string> = new Set(["", STR, BOOL, INT, FLOAT, NULL, TIMESTAMP]);

const RESOLVE_MAP: ReadonlyMap<string, string> = new Map([
  ...["true", "True", "TRUE", "false", "False", "FALSE"].map((s) => [s, BOOL] as const),
  ...["", "~", "null", "Null", "NULL"].map((s) => [s, NULL] as const),
  ...[
    ".nan",
    ".NaN",
    ".NAN",
    ".inf",
    ".Inf",
    ".INF",
    "+.inf",
    "+.Inf",
    "+.INF",
    "-.inf",
    "-.Inf",
    "-.INF",
  ].map((s) => [s, FLOAT] as const),
  ["<<", MERGE],
]);

// hint is yaml.v3's resolveTable: what the first byte says a plain scalar might be.
function hint(s: string): string {
  if (s === "") return "N";
  const c = s[0] ?? "";
  if (c === "+" || c === "-") return "S";
  if (c >= "0" && c <= "9") return "D";
  if ("yYnNtTfFoO~".includes(c)) return "M";
  return c === "." ? "." : "";
}

const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

// parseUnsigned is Go's strconv.ParseUint digits loop for one base, as a bigint, or undefined.
function parseDigits(s: string, base: number): bigint | undefined {
  if (s === "") return undefined;
  let n = 0n;
  for (const ch of s) {
    const d = Number.parseInt(ch, 36);
    if (Number.isNaN(d) || d >= base) return undefined;
    n = n * BigInt(base) + BigInt(d);
  }
  return n;
}

// goParseUint is strconv.ParseUint(s, base, 64). Base 0 reads a 0b, 0o, 0x or leading-0 prefix.
function goParseUint(s: string, base: number): bigint | undefined {
  if (s === "") return undefined;
  let b = base;
  let digits = s;
  if (base === 0) {
    b = 10;
    if (s[0] === "0") {
      const p = (s[1] ?? "").toLowerCase();
      if (s.length >= 3 && p === "b") [b, digits] = [2, s.slice(2)];
      else if (s.length >= 3 && p === "o") [b, digits] = [8, s.slice(2)];
      else if (s.length >= 3 && p === "x") [b, digits] = [16, s.slice(2)];
      else [b, digits] = [8, s.slice(1)];
      if (b === 8 && digits === "" && s === "0") return 0n;
    }
  }
  const n = parseDigits(digits, b);
  return n === undefined || n > UINT64_MAX ? undefined : n;
}

// goParseInt is strconv.ParseInt(s, base, 64).
function goParseInt(s: string, base: number): bigint | undefined {
  if (s === "") return undefined;
  const negative = s[0] === "-";
  const body = s[0] === "+" || s[0] === "-" ? s.slice(1) : s;
  const n = goParseUint(body, base);
  if (n === undefined) return undefined;
  if (negative ? n > INT64_MAX + 1n : n > INT64_MAX) return undefined;
  return negative ? -n : n;
}

// A float strconv.ParseFloat accepts that is not out of range. The syntax is checked by the caller.
function finiteFloat(s: string): boolean {
  return Number.isFinite(Number(s));
}

const YAML_STYLE_FLOAT = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;
const DOT_FLOAT = /^\.[0-9]+([eE][-+]?[0-9]+)?$/;

const TIMESTAMP_FORMATS: readonly RegExp[] = [
  /^(\d{4})-(\d\d?)-(\d\d?)T(\d\d?):(\d\d?):(\d\d?)(?:[.,]\d+)?(Z|[+-](\d\d):(\d\d))$/,
  /^(\d{4})-(\d\d?)-(\d\d?)t(\d\d?):(\d\d?):(\d\d?)(?:[.,]\d+)?(Z|[+-](\d\d):(\d\d))$/,
  /^(\d{4})-(\d\d?)-(\d\d?) (\d\d?):(\d\d?):(\d\d?)(?:[.,]\d+)?$/,
  /^(\d{4})-(\d\d?)-(\d\d?)$/,
];

function daysIn(month: number, year: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// parseTimestamp is yaml.v3's parseTimestamp: Go's time.Parse with its four layouts, whose fields take
// one or two digits and are range-checked.
function parseTimestamp(s: string): boolean {
  if (!/^\d{4}-/.test(s)) return false;
  for (const format of TIMESTAMP_FORMATS) {
    const m = format.exec(s);
    if (m === null) continue;
    const [year, month, day, hour = 0, minute = 0, second = 0] = m.slice(1, 7).map((v) => Number(v ?? 0));
    if (month === undefined || day === undefined || year === undefined) continue;
    if (month < 1 || month > 12 || day < 1 || day > daysIn(month, year)) continue;
    if (hour > 23 || minute > 59 || second > 59) continue;
    if (m[8] !== undefined && (Number(m[8]) > 24 || Number(m[9]) > 60)) continue;
    return true;
  }
  return false;
}

interface Resolved {
  readonly tag: string;
  readonly unsigned?: boolean;
}

// classify is the body of yaml.v3's resolve: the tag a plain value resolves to under the given tag.
function classify(tag: string, s: string): Resolved {
  const h = hint(s);
  if (h === "" || tag === STR) return { tag: STR };
  const fromMap = RESOLVE_MAP.get(s);
  if (fromMap !== undefined) return { tag: fromMap };
  if (h === "." && DOT_FLOAT.test(s) && finiteFloat(s)) return { tag: FLOAT };
  if (h === "D" || h === "S") {
    if ((tag === "" || tag === TIMESTAMP) && parseTimestamp(s)) return { tag: TIMESTAMP };
    const plain = s.replaceAll("_", "");
    if (goParseInt(plain, 0) !== undefined) return { tag: INT };
    if (goParseUint(plain, 0) !== undefined) return { tag: INT, unsigned: true };
    if (YAML_STYLE_FLOAT.test(plain) && finiteFloat(plain)) return { tag: FLOAT };
    if (plain.startsWith("0b")) {
      if (goParseInt(plain.slice(2), 2) !== undefined) return { tag: INT };
      if (goParseUint(plain.slice(2), 2) !== undefined) return { tag: INT, unsigned: true };
    } else if (plain.startsWith("-0b")) {
      if (goParseInt(`-${plain.slice(3)}`, 2) !== undefined) return { tag: INT };
    }
    if (plain.startsWith("0o")) {
      if (goParseInt(plain.slice(2), 8) !== undefined) return { tag: INT };
      if (goParseUint(plain.slice(2), 8) !== undefined) return { tag: INT, unsigned: true };
    } else if (plain.startsWith("-0o")) {
      if (goParseInt(`-${plain.slice(3)}`, 8) !== undefined) return { tag: INT };
    }
  }
  return { tag: STR };
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// TextDecoder is a global in every runtime libo11y supports (Node, Bun and browsers), but the ES library
// types this package builds against do not declare it.
declare const TextDecoder: new (
  label: string,
  options?: { fatal: boolean },
) => { decode(input: Uint8Array): string };

/** Decodes bytes as UTF-8, or as UTF-16 after a UTF-16 byte order mark, as yaml.v3's reader does. */
export function decodeInput(bytes: Uint8Array): string {
  let label = "utf-8";
  let input = bytes;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    label = "utf-16le";
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Swap to little-endian, which every runtime's TextDecoder supports.
    label = "utf-16le";
    input = new Uint8Array(bytes.length);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      input[i] = bytes[i + 1] as number;
      input[i + 1] = bytes[i] as number;
    }
    if (bytes.length % 2 === 1) input[bytes.length - 1] = bytes[bytes.length - 1] as number;
  }
  try {
    return new TextDecoder(label, { fatal: true }).decode(input);
  } catch {
    throw new YamlSyntaxError(`invalid ${label === "utf-8" ? "UTF-8" : "UTF-16"} input`);
  }
}

// decodeBase64 is Go's base64.StdEncoding.DecodeString, which skips line breaks, as UTF-8 text.
function decodeBase64(s: string): string {
  const compact = s.replace(/[\r\n]/g, "");
  if (!BASE64.test(compact)) throw new YamlSyntaxError("!!binary value contains invalid base64 data");
  const bytes: number[] = [];
  let bits = 0;
  let buffer = 0;
  for (const ch of compact) {
    if (ch === "=") break;
    buffer = (buffer << 6) | BASE64_ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

/** What a scalar decodes to: null, or its text and whether a Go interface{} would hold a string. */
export type ScalarValue =
  | { readonly isNull: true }
  | { readonly isNull: false; text: string; isString: boolean };

/**
 * Resolves a scalar the way yaml.v3's decoder does before storing it in a Go string. value is yaml.v3's
 * Node.Value, the folded text before tag resolution. quotedOrBlock is true for any non-plain style.
 * Throws YamlSyntaxError when an explicit tag does not fit the value, as yaml.v3 does.
 */
export function resolveScalar(tag: string | undefined, value: string, quotedOrBlock: boolean): ScalarValue {
  const short = shortTag(tag);
  if (short === STR || ((short === "" || short === "!") && quotedOrBlock)) {
    return { isNull: false, text: value, isString: true };
  }
  if (!RESOLVABLE.has(short)) {
    return short === BINARY
      ? { isNull: false, text: decodeBase64(value), isString: true }
      : { isNull: false, text: value, isString: true };
  }
  let resolved = classify(short, value);
  if (short === FLOAT && resolved.tag === INT && resolved.unsigned !== true) resolved = { tag: FLOAT };
  if (short !== "" && short !== resolved.tag) {
    throw new YamlSyntaxError(`cannot decode ${resolved.tag} \`${value}\` as a ${short}`);
  }
  if (resolved.tag === NULL) return { isNull: true };
  return { isNull: false, text: value, isString: resolved.tag === STR || resolved.tag === MERGE };
}
