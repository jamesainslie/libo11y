import assert from "node:assert/strict";
import { test } from "node:test";
import { base64Encode, utf8Decode, utf8Encode } from "./utf8.ts";

test("utf8Encode matches Buffer for every plane and replaces lone surrogates", () => {
  for (const s of ["", "abc", "café", "日本", "🎉", "\u{10ffff}", "a\ud800b", "\udc00", "x\ud83d"]) {
    assert.deepEqual(utf8Encode(s), new Uint8Array(Buffer.from(s, "utf8")), JSON.stringify(s));
  }
});

test("base64Encode matches Buffer", () => {
  for (let n = 0; n < 40; n++) {
    const data = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 0xff);
    assert.equal(base64Encode(data), Buffer.from(data).toString("base64"), `length ${n}`);
  }
});

test("utf8Decode matches TextDecoder, including invalid sequences", () => {
  const cases = [
    utf8Encode(""),
    utf8Encode("abc"),
    utf8Encode("café 日本 🎉 \u{10ffff}"),
    Uint8Array.of(0xff),
    Uint8Array.of(0xc3),
    Uint8Array.of(0xe6, 0x97),
    Uint8Array.of(0xc0, 0x80),
    Uint8Array.of(0xed, 0xa0, 0x80),
    Uint8Array.of(0xf4, 0x90, 0x80, 0x80),
    Uint8Array.of(0x61, 0xf0, 0x9f, 0x8e, 0x62),
  ];
  for (const bytes of cases) {
    assert.equal(utf8Decode(bytes), new TextDecoder().decode(bytes), Array.from(bytes).join(","));
  }
});
