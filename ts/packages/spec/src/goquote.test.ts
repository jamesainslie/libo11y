import assert from "node:assert/strict";
import { test } from "node:test";
import { goQuote } from "./goquote.ts";

// Each expected value is what Go's fmt.Sprintf("%q", s) prints.
const cases: readonly (readonly [string, string, string])[] = [
  ["plain ASCII", "studio", `"studio"`],
  ["empty", "", `""`],
  ["quote and backslash", `a"b\\c`, `"a\\"b\\\\c"`],
  ["short escapes", "\u0007\b\f\n\r\t\v", `"\\a\\b\\f\\n\\r\\t\\v"`],
  ["other C0 controls", "\u0000\u001b", `"\\x00\\x1b"`],
  ["DEL", "\u007f", `"\\x7f"`],
  ["printable non-ASCII stays as is", "café", `"café"`],
  ["NEL", "x\u0085", `"x\\u0085"`],
  ["no-break space is not printable", " ", `"\\u00a0"`],
  ["byte order mark", "﻿y", `"\\ufeffy"`],
  ["private use", "", `"\\ue000"`],
  ["astral printable stays as is", "\u{1f600}", `"\u{1f600}"`],
  ["astral format character", "\u{e0001}", `"\\U000e0001"`],
  ["line separator", " ", `"\\u2028"`],
  // Assigned after Unicode 15.0.0, so Go 1.26 escapes them while a newer JavaScript runtime prints them.
  ["Unicode 16 emoji", "\u{1fae9}", `"\\U0001fae9"`],
  ["Unicode 16 Cyrillic", "\u1c89", `"\\u1c89"`],
  ["Unicode 16 Arabic", "\u088f", `"\\u088f"`],
  ["fixture: unicode-quote", "café\t", `"café\\t"`],
  ["fixture: unicode-whitespace", " \u0007", `" \\a"`],
];

for (const [name, input, want] of cases) {
  test(`goQuote: ${name}`, () => {
    assert.equal(goQuote(input), want);
  });
}
