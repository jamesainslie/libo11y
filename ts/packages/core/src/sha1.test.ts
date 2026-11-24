import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sha1 } from "./sha1.ts";
import { utf8Encode } from "./utf8.ts";

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// FIPS 180-4 example vectors (and the NIST CSRC long-message example).
test("sha1 reproduces the FIPS 180 vectors", () => {
  const cases: [string, string][] = [
    ["abc", "a9993e364706816aba3e25717850c26c9cd0d89d"],
    ["", "da39a3ee5e6b4b0d3255bfef95601890afd80709"],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "84983e441c3bd26ebaae4aa1f95129e5e54670f1"],
    [
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      "a49b2446a02c645bf419f995b67091253a04a259",
    ],
  ];
  for (const [input, want] of cases) assert.equal(hex(sha1(utf8Encode(input))), want, input);
  assert.equal(hex(sha1(new Uint8Array(1_000_000).fill(0x61))), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
});

test("sha1 agrees with node:crypto at every length around the block boundaries", () => {
  for (let n = 0; n <= 200; n++) {
    const data = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
    assert.equal(hex(sha1(data)), createHash("sha1").update(data).digest("hex"), `length ${n}`);
  }
});
