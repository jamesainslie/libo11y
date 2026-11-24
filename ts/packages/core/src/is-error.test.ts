import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { isError, isErrorLike } from "./is-error.ts";

const foreign = (): unknown => runInNewContext("new TypeError('from another realm')");

test("isError recognises errors from this realm and another", () => {
  assert.equal(isError(new Error("x")), true);
  assert.equal(isError(new RangeError("x")), true);
  const other = foreign();
  assert.equal(other instanceof Error, false, "the vm realm has its own Error");
  assert.equal(isError(other), true);
});

test("isError rejects look-alikes and non-objects", () => {
  for (const v of [null, undefined, "Error: x", 1, {}, { name: "Error", message: "x" }, []]) {
    assert.equal(isError(v), false, JSON.stringify(v));
  }
});

test("the fallback accepts a foreign error and rejects a plain object", () => {
  assert.equal(isErrorLike(foreign()), true);
  assert.equal(isErrorLike(new Error("x")), true);
  assert.equal(isErrorLike({ name: "Error", message: "x" }), false);
  assert.equal(isErrorLike({ name: "Error", message: "x", stack: 1 }), false, "a non-string stack");
});
