import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { hmacSha256, sha256 } from "./hmac.ts";
import { hexEncode, utf8Encode } from "./utf8.ts";

function fromHex(h: string): Uint8Array {
  return Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}

// FIPS 180-4 SHA-256 examples, and the NIST long-message examples.
test("sha256 reproduces the FIPS 180 vectors", () => {
  const cases: [string, string][] = [
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    [
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
    ],
  ];
  for (const [input, want] of cases) assert.equal(hexEncode(sha256(utf8Encode(input))), want, input);
  assert.equal(
    hexEncode(sha256(new Uint8Array(1_000_000).fill(0x61))),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  );
});

test("sha256 agrees with node:crypto at every length around the block boundaries", () => {
  for (let n = 0; n <= 200; n++) {
    const data = Uint8Array.from({ length: n }, (_, i) => (i * 131 + n) & 0xff);
    assert.equal(hexEncode(sha256(data)), createHash("sha256").update(data).digest("hex"), `length ${n}`);
  }
});

// RFC 4231, test cases 1 to 7. Case 5 checks only the first 128 bits.
test("hmacSha256 reproduces RFC 4231", () => {
  const aa131 = "aa".repeat(131);
  const cases: { key: string; data: Uint8Array; want: string; truncate?: number }[] = [
    {
      key: "0b".repeat(20),
      data: utf8Encode("Hi There"),
      want: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    },
    {
      key: hexEncode(utf8Encode("Jefe")),
      data: utf8Encode("what do ya want for nothing?"),
      want: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    },
    {
      key: "aa".repeat(20),
      data: fromHex("dd".repeat(50)),
      want: "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
    },
    {
      key: "0102030405060708090a0b0c0d0e0f10111213141516171819",
      data: fromHex("cd".repeat(50)),
      want: "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b",
    },
    {
      key: "0c".repeat(20),
      data: utf8Encode("Test With Truncation"),
      want: "a3b6167473100ee06e0c796c2955552b",
      truncate: 16,
    },
    {
      key: aa131,
      data: utf8Encode("Test Using Larger Than Block-Size Key - Hash Key First"),
      want: "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
    },
    {
      key: aa131,
      data: utf8Encode(
        "This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.",
      ),
      want: "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
    },
  ];
  for (const [i, c] of cases.entries()) {
    const mac = hmacSha256(fromHex(c.key), c.data);
    assert.equal(hexEncode(mac.subarray(0, c.truncate ?? 32)), c.want, `case ${i + 1}`);
  }
});

test("hmacSha256 agrees with node:crypto for keys around the block size", () => {
  for (const keyLen of [0, 1, 32, 63, 64, 65, 200]) {
    const key = Uint8Array.from({ length: keyLen }, (_, i) => (i * 7 + 3) & 0xff);
    const data = Uint8Array.from({ length: 100 }, (_, i) => i & 0xff);
    assert.equal(
      hexEncode(hmacSha256(key, data)),
      createHmac("sha256", key).update(data).digest("hex"),
      `key length ${keyLen}`,
    );
  }
});
