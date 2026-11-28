import assert from "node:assert/strict";
import { test } from "node:test";
import { maskText } from "./mask.ts";

test("every character but ASCII whitespace becomes *", () => {
  assert.equal(maskText("Jane Doe\n42 Main St"), "**** ***\n** **** **");
  assert.equal(maskText("\t \r\n\f\v"), "\t \r\n\f\v");
  assert.equal(maskText(""), "");
});

test("non-ASCII whitespace, NEL and BOM are masked, so TypeScript and Go agree", () => {
  assert.equal(maskText("a b\u0085c﻿d e　"), "**********");
});

test("astral characters and lone surrogates mask to one * each", () => {
  assert.equal(maskText("\u{1f600}x"), "**");
  assert.equal(maskText("a\ud800b"), "***");
  assert.equal(maskText("é"), "**");
});
