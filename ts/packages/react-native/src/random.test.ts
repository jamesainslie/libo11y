import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUuid } from "@libo11y/web/portable";
import { uuidCrypto } from "./random.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("the given getRandomValues fills the bytes, and randomUUID is never used", () => {
  let calls = 0;
  const c = uuidCrypto((a) => {
    calls++;
    return a.fill(0xab);
  });
  assert.ok(c);
  assert.equal(c.randomUUID, undefined);
  const id = randomUuid(c);
  assert.equal(calls, 1);
  assert.match(id, UUID);
  assert.equal(id, "abababab-abab-4bab-abab-abababababab");
});

test("without one, the runtime's crypto, else Math.random", () => {
  assert.equal(uuidCrypto(), globalThis.crypto);
  const before = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
  try {
    const c = uuidCrypto();
    assert.deepEqual(c, {}, "an empty source: randomUuid falls back to Math.random");
    assert.match(randomUuid(c), UUID);
  } finally {
    if (before !== undefined) Object.defineProperty(globalThis, "crypto", before);
  }
});
