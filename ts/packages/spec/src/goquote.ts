/**
 * Go's %q quoting (strconv.Quote), so messages that quote a value match the Go implementation byte for
 * byte. Printable characters stay as they are; everything else is escaped the way Go escapes it.
 * "Printable" is Go's unicode.IsPrint, read from a table specgen generates, because JavaScript's
 * \p{...} classes follow the runtime's Unicode version rather than the Go toolchain's.
 */
import { GO_PRINT_RANGES } from "./generated/goprint.ts";

// isPrint reports whether cp lies in one of GO_PRINT_RANGES' inclusive [lo, hi] pairs.
function isPrint(cp: number): boolean {
  // Find the first bound >= cp. cp is inside a pair when that bound is a hi, or is the lo it equals.
  let lo = 0;
  let hi = GO_PRINT_RANGES.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((GO_PRINT_RANGES[mid] as number) < cp) lo = mid + 1;
    else hi = mid;
  }
  return lo < GO_PRINT_RANGES.length && (lo % 2 === 1 || GO_PRINT_RANGES[lo] === cp);
}

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  "\u0007": "\\a",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\v": "\\v",
};

function hex(cp: number, width: number): string {
  return cp.toString(16).padStart(width, "0");
}

/** Quotes s as Go's fmt %q verb does for a string. */
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === "\\") {
      out += `\\${ch}`;
    } else if (isPrint(cp)) {
      out += ch;
    } else if (SHORT_ESCAPES[ch] !== undefined) {
      out += SHORT_ESCAPES[ch];
    } else if (cp < 0x20 || cp === 0x7f) {
      out += `\\x${hex(cp, 2)}`;
    } else if (cp < 0x10000) {
      out += `\\u${hex(cp, 4)}`;
    } else {
      out += `\\U${hex(cp, 8)}`;
    }
  }
  return `${out}"`;
}
