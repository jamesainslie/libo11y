import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { serverPlatform } from "./platform.ts";

test("serverPlatform is named server and reads process.env", () => {
  const p = serverPlatform();
  assert.equal(p.name, "server");
  assert.equal(p.env(), process.env);
  assert.equal(p.console, globalThis.console);
});

test("serverPlatform's context manager is a fresh AsyncLocalStorage manager", () => {
  const p = serverPlatform();
  const a = p.contextManager();
  const b = p.contextManager();
  assert.notEqual(a, b);
  assert.equal(a.active(), ROOT_CONTEXT);
  assert.equal(
    a.with(ROOT_CONTEXT.setValue(Symbol.for("k"), 1), () => a.active().getValue(Symbol.for("k"))),
    1,
  );
  a.disable();
  b.disable();
});

function capture(stream: NodeJS.WriteStream, fn: () => void): string {
  const original = stream.write;
  let written = "";
  stream.write = ((chunk: string | Uint8Array): boolean => {
    written += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof stream.write;
  try {
    fn();
  } finally {
    stream.write = original;
  }
  return written;
}

test("writeConsoleLine writes one line to stdout and writeDiagnosticLine to stderr", () => {
  const p = serverPlatform();
  assert.equal(
    capture(process.stdout, () => p.writeConsoleLine('{"msg":"hi"}')),
    '{"msg":"hi"}\n',
  );
  assert.equal(
    capture(process.stderr, () => p.writeDiagnosticLine("level=WARN msg=x")),
    "level=WARN msg=x\n",
  );
});

test("sha1 and hmacSha256 are node:crypto's", async () => {
  const p = serverPlatform();
  const data = new TextEncoder().encode("libo11y");
  const key = new Uint8Array(32).fill(7);
  assert.deepEqual(await p.sha1(data), new Uint8Array(createHash("sha1").update(data).digest()));
  assert.ok(p.hmacSha256 !== undefined);
  assert.deepEqual(p.hmacSha256(key, data), new Uint8Array(createHmac("sha256", key).update(data).digest()));
});

test("randomUUID returns lowercase v4 UUIDs", () => {
  const p = serverPlatform();
  const a = p.randomUUID();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, p.randomUUID());
});

test("detectResource is the server resource detection", async () => {
  const layers = await serverPlatform().detectResource(true);
  assert.equal(layers.detected["process.runtime.name"], "Bun" in globalThis ? "bun" : "nodejs");
  assert.deepEqual(layers.fromEnv, {});
});
