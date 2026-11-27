import assert from "node:assert/strict";
import { test } from "node:test";
import { fnv1a32, sessionSampled } from "./sampling.ts";

test("fnv1a32 matches the published FNV-1a 32-bit vectors", () => {
  assert.equal(fnv1a32(""), 0x811c9dc5);
  assert.equal(fnv1a32("a"), 0xe40c292c);
  assert.equal(fnv1a32("foobar"), 0xbf9cf968);
});

test("fnv1a32 hashes UTF-8 bytes, not UTF-16 code units", () => {
  assert.equal(fnv1a32("é"), fnv1a32Bytes([0xc3, 0xa9]));
});

function fnv1a32Bytes(bytes: number[]): number {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

test("sessionSampled is deterministic and honours the bounds", () => {
  const id = "7d3f2c8a-1b4e-4c6d-9a0f-2e5b8c1d4f6a";
  assert.equal(sessionSampled(id, 0), false);
  assert.equal(sessionSampled(id, 1), true);
  assert.equal(sessionSampled(id, Number.NaN), false);
  assert.equal(sessionSampled(id, 0.5), sessionSampled(id, 0.5));
  assert.equal(sessionSampled(id, 0.5), fnv1a32(id) / 2 ** 32 < 0.5);
});

test("sessionSampled keeps about rate of many sessions", () => {
  let kept = 0;
  for (let i = 0; i < 10_000; i++) if (sessionSampled(`session-${i}`, 0.25)) kept++;
  assert.ok(kept > 2300 && kept < 2700, `kept ${kept}`);
});
