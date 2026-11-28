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

test("randomUuid works without Web Crypto, as on Hermes", (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
  t.after(() => {
    if (saved !== undefined) Object.defineProperty(globalThis, "crypto", saved);
  });
  const a = randomUuid();
  assert.match(a, UUID_V4);
  assert.notEqual(randomUuid(), a);
});

test("randomUuid does not call randomUUID outside a secure context", (t) => {
  const g = globalThis as { isSecureContext?: boolean };
  const before = g.isSecureContext;
  const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  g.isSecureContext = false;
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => "insecure", getRandomValues: (a: Uint8Array) => a.fill(0) },
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (before === undefined) delete g.isSecureContext;
    else g.isSecureContext = before;
    if (saved !== undefined) Object.defineProperty(globalThis, "crypto", saved);
  });
  assert.equal(randomUuid(), "00000000-0000-4000-8000-000000000000");
});
