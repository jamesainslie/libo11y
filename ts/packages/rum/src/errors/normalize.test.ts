import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeError } from "./normalize.ts";

test("normalizeError reads errors, strings and anything else", () => {
  const e = new TypeError("bad");
  assert.deepEqual(normalizeError(e), { type: "TypeError", message: "bad", stack: e.stack });
  assert.deepEqual(normalizeError("boom"), { type: "Error", message: "boom" });
  assert.deepEqual(normalizeError({ name: "X", message: "y" }), { type: "X", message: "y" });
  assert.deepEqual(normalizeError(42), { type: "number", message: "42" });
  assert.deepEqual(normalizeError(null), { type: "null", message: "null" });
  assert.deepEqual(normalizeError(undefined), { type: "undefined", message: "undefined" });
});

test("a long message is cut to 1024 characters", () => {
  assert.equal(normalizeError("x".repeat(5000)).message.length, 1024);
});

test("an object whose toString throws still normalizes", () => {
  const nasty = {
    toString() {
      throw new Error("no");
    },
  };
  assert.deepEqual(normalizeError(nasty), { type: "object", message: "[object]" });
});
