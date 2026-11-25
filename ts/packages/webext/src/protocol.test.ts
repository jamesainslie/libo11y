import assert from "node:assert/strict";
import { test } from "node:test";
import { isExportMessage, isReply, isTracedMessage, PROTOCOL_VERSION } from "./protocol.ts";

test("PROTOCOL_VERSION is 1", () => {
  assert.equal(PROTOCOL_VERSION, 1);
});

test("isExportMessage accepts every signal with a string body", () => {
  for (const signal of ["traces", "metrics", "logs"]) {
    assert.equal(isExportMessage({ libo11y: 1, type: "export", signal, body: "{}" }), true, signal);
  }
  assert.equal(isExportMessage({ libo11y: 1, type: "export", signal: "logs", body: "" }), true);
});

test("isExportMessage refuses anything else", () => {
  const bad: unknown[] = [
    undefined,
    null,
    "export",
    42,
    [],
    {},
    { libo11y: 2, type: "export", signal: "traces", body: "{}" },
    { libo11y: "1", type: "export", signal: "traces", body: "{}" },
    { type: "export", signal: "traces", body: "{}" },
    { libo11y: 1, type: "traced", signal: "traces", body: "{}" },
    { libo11y: 1, type: "export", signal: "profiles", body: "{}" },
    { libo11y: 1, type: "export", body: "{}" },
    { libo11y: 1, type: "export", signal: "traces" },
    { libo11y: 1, type: "export", signal: "traces", body: { resourceSpans: [] } },
  ];
  for (const m of bad) assert.equal(isExportMessage(m), false, JSON.stringify(m));
});

test("isTracedMessage accepts a carrier of strings and any payload", () => {
  assert.equal(isTracedMessage({ libo11y: 1, type: "traced", carrier: {}, payload: undefined }), true);
  assert.equal(isTracedMessage({ libo11y: 1, type: "traced", carrier: {} }), true);
  assert.equal(
    isTracedMessage({
      libo11y: 1,
      type: "traced",
      carrier: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", baggage: "a=b" },
      payload: { op: "x", n: [1, 2] },
    }),
    true,
  );
});

test("isTracedMessage refuses anything else", () => {
  const bad: unknown[] = [
    undefined,
    null,
    "traced",
    { libo11y: 2, type: "traced", carrier: {}, payload: 1 },
    { type: "traced", carrier: {}, payload: 1 },
    { libo11y: 1, type: "export", carrier: {}, payload: 1 },
    { libo11y: 1, type: "traced", payload: 1 },
    { libo11y: 1, type: "traced", carrier: null, payload: 1 },
    { libo11y: 1, type: "traced", carrier: "traceparent", payload: 1 },
    { libo11y: 1, type: "traced", carrier: ["x"], payload: 1 },
    { libo11y: 1, type: "traced", carrier: { traceparent: 7 }, payload: 1 },
  ];
  for (const m of bad) assert.equal(isTracedMessage(m), false, JSON.stringify(m));
});

test("isReply accepts export and traced replies", () => {
  assert.equal(isReply({ libo11y: 1, type: "export-reply", ok: true }), true);
  assert.equal(isReply({ libo11y: 1, type: "export-reply", ok: false, reason: "consent" }), true);
  assert.equal(isReply({ libo11y: 1, type: "traced-reply", ok: true, result: { a: 1 } }), true);
  assert.equal(isReply({ libo11y: 1, type: "traced-reply", ok: true }), true);
  assert.equal(isReply({ libo11y: 1, type: "traced-reply", ok: false, error: "boom" }), true);
});

test("isReply refuses anything else", () => {
  const bad: unknown[] = [
    undefined,
    null,
    { libo11y: 2, type: "export-reply", ok: true },
    { type: "export-reply", ok: true },
    { libo11y: 1, type: "export", ok: true },
    { libo11y: 1, type: "export-reply" },
    { libo11y: 1, type: "export-reply", ok: "yes" },
    { libo11y: 1, type: "export-reply", ok: false, reason: 3 },
    { libo11y: 1, type: "traced-reply", ok: false, error: { message: "x" } },
    { libo11y: 1, type: "traced", carrier: {}, payload: 1 },
  ];
  for (const m of bad) assert.equal(isReply(m), false, JSON.stringify(m));
});
