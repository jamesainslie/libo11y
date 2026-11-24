import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { renderCanonical } from "./canonical.ts";

const vectorsPath = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "conformance",
  "vectors",
  "pii-hash.json",
);

interface PiiCase {
  name: string;
  kind: string;
  value: unknown;
  canonical: string;
  token: string;
}

const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as { key_hex: string; cases: PiiCase[] };

// input turns a vector's JSON value into the value a caller would hold: bytes arrive as base64.
function vectorInput(c: PiiCase): unknown {
  return c.kind === "bytes" ? new Uint8Array(Buffer.from(c.value as string, "base64")) : c.value;
}

test("the vectors file holds every kind", () => {
  const kinds = new Set(vectors.cases.map((c) => c.kind));
  for (const k of ["string", "int", "float", "bool", "string_array", "int_array", "bytes", "map"]) {
    assert.ok(kinds.has(k), k);
  }
});

for (const c of vectors.cases) {
  test(`canonical: ${c.name}`, () => {
    assert.equal(renderCanonical(vectorInput(c)), c.canonical);
  });
}

test("Go's 'g' format picks the exponent form below 1e-4 and from 1e6 up", () => {
  const cases: [number, string][] = [
    [0.0001, "0.0001"],
    [0.00012, "0.00012"],
    [0.000012, "1.2e-05"],
    [999999.5, "999999.5"],
    [1000000.5, "1.0000005e+06"],
    [-1234567.25, "-1.23456725e+06"],
    [9007199254740992, "9.007199254740992e+15"],
    [-9007199254740992, "-9.007199254740992e+15"],
    [1.5e300, "1.5e+300"],
    [5e-324, "5e-324"],
    [0.5, "0.5"],
    [-0.5, "-0.5"],
  ];
  for (const [n, want] of cases) assert.equal(renderCanonical(n), want, String(n));
});

test("non-finite numbers render as Go renders them", () => {
  assert.equal(renderCanonical(Number.NaN), "NaN");
  assert.equal(renderCanonical(Number.POSITIVE_INFINITY), "+Inf");
  assert.equal(renderCanonical(Number.NEGATIVE_INFINITY), "-Inf");
  assert.equal(renderCanonical([Number.NaN, Number.NEGATIVE_INFINITY]), '["NaN","-Inf"]');
});

test("negative zero is a safe integer and renders as 0", () => {
  assert.equal(renderCanonical(-0), "0");
});

test("bigints render as integers", () => {
  assert.equal(renderCanonical(12345678901234567890n), "12345678901234567890");
  assert.equal(renderCanonical([-1n]), '["-1"]');
});

test("the type is not encoded", () => {
  assert.equal(renderCanonical("1"), renderCanonical(1));
  assert.equal(renderCanonical(true), "true");
});

test("a cycle renders as truncated", () => {
  const a: Record<string, unknown> = { x: "1" };
  a.self = a;
  assert.equal(renderCanonical(a), '{"self":"truncated","x":"1"}');
  const arr: unknown[] = ["a"];
  arr.push(arr);
  assert.equal(renderCanonical(arr), '["a","truncated"]');
});

test("a value shared outside the current path is rendered each time", () => {
  const shared = { v: "s" };
  assert.equal(renderCanonical({ a: shared, b: shared }), '{"a":{"v":"s"},"b":{"v":"s"}}');
});

test("bytes inside a composite render as base64 strings", () => {
  assert.equal(renderCanonical({ b: new Uint8Array([0, 1, 2]) }), '{"b":"AAEC"}');
});

test("lone surrogates in strings become U+FFFD inside JSON, as Go's encoder does", () => {
  assert.equal(renderCanonical(["a\ud800"]), '["a�"]');
});

test("an Error renders as its string form", () => {
  assert.equal(renderCanonical(new TypeError("bad")), "TypeError: bad");
});

test("null and undefined render as Go's nil", () => {
  assert.equal(renderCanonical(null), "<nil>");
  assert.equal(renderCanonical([undefined]), '["\\u003cnil\\u003e"]');
});
