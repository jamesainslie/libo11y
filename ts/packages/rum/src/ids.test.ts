import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUuid } from "./ids.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("randomUuid returns distinct v4 UUIDs", () => {
  const a = randomUuid();
  const b = randomUuid();
  assert.match(a, UUID_V4);
  assert.notEqual(a, b);
});

test("randomUuid falls back to getRandomValues outside a secure context", () => {
  const g = globalThis as { isSecureContext?: boolean };
  const before = g.isSecureContext;
  g.isSecureContext = false;
  try {
    assert.match(randomUuid(), UUID_V4);
  } finally {
    if (before === undefined) delete g.isSecureContext;
    else g.isSecureContext = before;
  }
});
