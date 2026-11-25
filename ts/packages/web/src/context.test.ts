import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { StackContextManager } from "@opentelemetry/sdk-trace";
import { createContextManager } from "./context.ts";

const KEY = Symbol.for("libo11y.web.context.test");

test("createContextManager returns a fresh, enabled StackContextManager", () => {
  const a = createContextManager();
  const b = createContextManager();
  try {
    assert.ok(a instanceof StackContextManager);
    assert.notEqual(a, b);
    assert.equal(a.active(), ROOT_CONTEXT);
    assert.equal(
      a.with(ROOT_CONTEXT.setValue(KEY, 1), () => a.active().getValue(KEY)),
      1,
    );
    assert.equal(a.active(), ROOT_CONTEXT);
  } finally {
    a.disable();
    b.disable();
  }
});

test("enabling the manager again is a no-op that keeps the active context", () => {
  const m = createContextManager();
  try {
    m.with(ROOT_CONTEXT.setValue(KEY, 2), () => {
      assert.equal(m.enable(), m);
      assert.equal(m.active().getValue(KEY), 2);
    });
  } finally {
    m.disable();
  }
});
