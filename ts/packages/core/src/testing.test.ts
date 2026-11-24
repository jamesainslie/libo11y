import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createTestPlatform } from "./testing.ts";

const contextManager = () => new AsyncLocalStorageContextManager();

test("the test platform is hermetic and captures console lines", async () => {
  const p = createTestPlatform({ contextManager });
  assert.equal(p.name, "test");
  assert.deepEqual(p.env(), {});
  const layers = await p.detectResource(false);
  assert.deepEqual(layers.fromEnv, {});
  const keys = Object.keys(layers.detected).sort();
  assert.deepEqual(keys, ["telemetry.sdk.language", "telemetry.sdk.name", "telemetry.sdk.version"]);
  assert.equal(layers.detected["telemetry.sdk.name"], "opentelemetry");
  p.writeConsoleLine("one");
  p.writeConsoleLine("two");
  p.writeDiagnosticLine("diag");
  assert.deepEqual(p.lines, ["one", "two"]);
  assert.deepEqual(p.diagnostics, ["diag"]);
  assert.deepEqual(p.buildExporters({} as never), {});
  assert.ok(p.contextManager() instanceof AsyncLocalStorageContextManager);
});

test("the test platform hashes with the pure sha1 and makes v4 uuids", async () => {
  const p = createTestPlatform({ contextManager });
  const digest = await p.sha1(new Uint8Array([0x61, 0x62, 0x63]));
  assert.equal(Buffer.from(digest).toString("hex"), "a9993e364706816aba3e25717850c26c9cd0d89d");
  const id = p.randomUUID();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(p.randomUUID(), id);
});

test("overrides replace the defaults", async () => {
  const p = createTestPlatform({
    contextManager,
    name: "custom",
    env: () => ({ OTEL_SERVICE_NAME: "svc" }),
    randomUUID: () => "fixed",
    detectResource: async () => ({ detected: { a: 1 }, fromEnv: { b: 2 } }),
  });
  assert.equal(p.name, "custom");
  assert.deepEqual(p.env(), { OTEL_SERVICE_NAME: "svc" });
  assert.equal(p.randomUUID(), "fixed");
  assert.deepEqual(await p.detectResource(true), { detected: { a: 1 }, fromEnv: { b: 2 } });
});

test("a write override still lets the console lines be inspected", () => {
  const p = createTestPlatform({
    contextManager,
    writeConsoleLine: () => {
      throw new Error("rejected");
    },
  });
  assert.throws(() => p.writeConsoleLine("x"), /rejected/);
  assert.deepEqual(p.lines, []);
});
