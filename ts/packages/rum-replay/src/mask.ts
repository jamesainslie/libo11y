/**
 * Text masking. Every code point except ASCII whitespace becomes "*", so a recording keeps the
 * layout of text and none of its content. The kept set is ASCII space, tab, line feed, carriage
 * return, form feed and vertical tab, and nothing else: NBSP, NEL, the BOM and other Unicode
 * whitespace are masked, so every implementation (the gateway's Go scrubber included) agrees on
 * the output byte for byte. A lone surrogate counts as one code point.
 */
const KEPT: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

/** s with every code point except ASCII whitespace replaced by "*". */
export function maskText(s: string): string {
  let out = "";
  for (const ch of s) out += KEPT.has(ch) ? ch : "*";
  return out;
}
