/**
 * Go's %q quoting (strconv.Quote), so messages that quote a value match the Go implementation byte for
 * byte. Printable characters stay as they are; everything else is escaped the way Go escapes it.
 */

// Go's strconv.IsPrint: letters, marks, numbers, punctuation, symbols, and the ASCII space.
const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;

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
    } else if (PRINTABLE.test(ch)) {
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
