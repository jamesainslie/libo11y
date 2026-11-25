/** gzip through CompressionStream, and its absence. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { canGzip, gzip } from "./compress.ts";

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

test("gzip round trips through DecompressionStream", async () => {
  assert.equal(canGzip(), true);
  const text = JSON.stringify({ resourceSpans: [{ hello: "world".repeat(100) }] });
  const out = await gzip(new TextEncoder().encode(text));
  assert.ok(out instanceof Uint8Array);
  assert.equal(out[0], 0x1f);
  assert.equal(out[1], 0x8b);
  assert.ok(out.byteLength < text.length);
  assert.equal(await gunzip(out), text);
});

test("without CompressionStream canGzip is false and gzip gives undefined", async () => {
  const g = globalThis as { CompressionStream?: unknown };
  const saved = g.CompressionStream;
  try {
    delete g.CompressionStream;
    assert.equal(canGzip(), false);
    assert.equal(await gzip(new TextEncoder().encode("{}")), undefined);
  } finally {
    g.CompressionStream = saved;
  }
});

test("a CompressionStream that throws gives undefined, never a rejection", async () => {
  const g = globalThis as { CompressionStream?: unknown };
  const saved = g.CompressionStream;
  try {
    g.CompressionStream = class {
      constructor() {
        throw new Error("boom");
      }
    };
    assert.equal(canGzip(), false);
    assert.equal(await gzip(new TextEncoder().encode("{}")), undefined);
  } finally {
    g.CompressionStream = saved;
  }
});
