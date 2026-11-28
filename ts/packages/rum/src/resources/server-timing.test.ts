import assert from "node:assert/strict";
import { test } from "node:test";
import { readServerTiming } from "./server-timing.ts";

test("traceparent becomes the remote span; other entries become entries in seconds", () => {
  const r = readServerTiming([
    {
      name: "traceparent",
      duration: 0,
      description: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    },
    { name: "db", duration: 42, description: "" },
    { name: "cache", duration: 0, description: "hit" },
  ]);
  assert.equal(r.remote?.traceId, "0af7651916cd43dd8448eb211c80319c");
  assert.equal(r.remote?.spanId, "b7ad6b7169203331");
  assert.deepEqual(r.entries, [
    { name: "db", seconds: 0.042 },
    { name: "cache", seconds: 0 },
  ]);
});

test("a malformed traceparent is ignored and not reported as an entry", () => {
  const r = readServerTiming([{ name: "traceparent", duration: 0, description: "nope" }]);
  assert.equal(r.remote, undefined);
  assert.deepEqual(r.entries, []);
});

test("entries without a name or with a non-finite duration are left out, and at most 10 are kept", () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ name: `m${i}`, duration: i, description: "" }));
  const r = readServerTiming([
    { name: "", duration: 1, description: "" },
    { name: "x", duration: Number.NaN, description: "" },
    ...many,
  ]);
  assert.equal(r.entries.length, 10);
  assert.equal(r.entries[0]?.name, "m0");
});
