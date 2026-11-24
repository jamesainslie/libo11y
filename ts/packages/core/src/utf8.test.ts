import assert from "node:assert/strict";
import { test } from "node:test";
import { base64Encode, utf8Encode } from "./utf8.ts";

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
