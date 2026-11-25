import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChromeLike } from "./chrome.ts";
import { createMessagingTransport } from "./messaging-transport.ts";
import { createFakeExtension } from "./test-support/fake-chrome.ts";

function chromeSending(send: (message: unknown) => Promise<unknown>): ChromeLike & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    runtime: {
      id: "x",
      getManifest: () => ({ name: "x", version: "1" }),
      sendMessage: (m) => {
        sent.push(m);
        return send(m);
      },
      onMessage: { addListener() {}, removeListener() {} },
    },
  };
}

test("each batch goes to the worker as an ExportMessage, body unchanged", async () => {
  const chrome = chromeSending(async () => ({ libo11y: 1, type: "export-reply", ok: true }));
  const body = JSON.stringify({ resourceSpans: [{ scopeSpans: [] }] });
  const result = await createMessagingTransport(chrome).send({ signal: "traces", body, mode: "normal" });
  assert.deepEqual(result, { kind: "ok" });
  assert.deepEqual(chrome.sent, [{ libo11y: 1, type: "export", signal: "traces", body }]);
});

test("the mode is ignored: unload sends by messaging too", async () => {
  const chrome = chromeSending(async () => ({ libo11y: 1, type: "export-reply", ok: true }));
  const result = await createMessagingTransport(chrome).send({ signal: "logs", body: "{}", mode: "unload" });
  assert.deepEqual(result, { kind: "ok" });
  assert.equal(chrome.sent.length, 1);
});

test("a refusal is fatal with the worker's reason", async () => {
  const chrome = chromeSending(async () => ({
    libo11y: 1,
    type: "export-reply",
    ok: false,
    reason: "consent",
  }));
  const result = await createMessagingTransport(chrome).send({ signal: "logs", body: "{}", mode: "normal" });
  assert.equal(result.kind, "fatal");
  assert.match(result.kind === "fatal" ? result.reason : "", /consent/);
});

test("a refusal without a reason is still fatal", async () => {
  const chrome = chromeSending(async () => ({ libo11y: 1, type: "export-reply", ok: false }));
  const result = await createMessagingTransport(chrome).send({ signal: "logs", body: "{}", mode: "normal" });
  assert.equal(result.kind, "fatal");
});

test("a rejected sendMessage is a retry", async () => {
  const chrome = chromeSending(async () => {
    throw new Error("Could not establish connection. Receiving end does not exist.");
  });
  const result = await createMessagingTransport(chrome).send({
    signal: "metrics",
    body: "{}",
    mode: "normal",
  });
  assert.equal(result.kind, "retry");
  assert.match(result.kind === "retry" ? result.reason : "", /Receiving end/);
});

test("a sendMessage that throws synchronously is a retry", async () => {
  const chrome = chromeSending(() => {
    throw new Error("Extension context invalidated.");
  });
  const result = await createMessagingTransport(chrome).send({
    signal: "metrics",
    body: "{}",
    mode: "normal",
  });
  assert.equal(result.kind, "retry");
});

test("no answer, or an answer that is not an ExportReply, is a retry", async () => {
  for (const answer of [undefined, { wakes: 1 }, { libo11y: 1, type: "traced-reply", ok: true }]) {
    const chrome = chromeSending(async () => answer);
    const result = await createMessagingTransport(chrome).send({
      signal: "logs",
      body: "{}",
      mode: "normal",
    });
    assert.equal(result.kind, "retry", JSON.stringify(answer));
  }
});

test("a worker that never answers times out as a retry", async () => {
  const chrome = chromeSending(() => new Promise(() => {}));
  const started = Date.now();
  const result = await createMessagingTransport(chrome, 30).send({
    signal: "logs",
    body: "{}",
    mode: "normal",
  });
  assert.equal(result.kind, "retry");
  assert.match(result.kind === "retry" ? result.reason : "", /timeout/);
  assert.ok(Date.now() - started >= 25);
});

test("through the fake extension: no worker listener is a retry", async () => {
  const ext = createFakeExtension();
  const content = ext.context({ tabId: 1 });
  const result = await createMessagingTransport(content.chrome).send({
    signal: "traces",
    body: "{}",
    mode: "normal",
  });
  assert.equal(result.kind, "retry");
});
