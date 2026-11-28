import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUuid } from "./ids.ts";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("uses randomUUID when there is one", () => {
  assert.equal(randomUuid({ randomUUID: () => "x", getRandomValues: (a) => a }), "x");
});

test("builds a v4 UUID from getRandomValues", () => {
  assert.equal(randomUuid({ getRandomValues: (a) => a.fill(0xff) }), "ffffffff-ffff-4fff-bfff-ffffffffffff");
});

test("calls getRandomValues on its crypto, as Web Crypto requires", () => {
  const c = {
    getRandomValues(this: unknown, a: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
      assert.equal(this, c);
      return a.fill(1);
    },
  };
  assert.match(randomUuid(c), V4);
});

test("falls back to Math.random without getRandomValues, as on Hermes", () => {
  const a = randomUuid({});
  assert.match(a, V4);
  assert.notEqual(randomUuid({}), a);
});

test("the default crypto is read when called, so a runtime without one still gets IDs", (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
  t.after(() => {
    if (saved !== undefined) Object.defineProperty(globalThis, "crypto", saved);
  });
  const a = randomUuid();
  assert.match(a, V4);
  assert.notEqual(randomUuid(), a);
});
