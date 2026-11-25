/**
 * Scaffold. The shared doubles behave as the contracts say, and testPlatform drives real core
 * telemetry with the gate closing and opening recording (once WP2 wires the gate into core).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTelemetryWith } from "@libo11y/core";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { createFakeGate, createFakeQueue, createFakeTransport, testPlatform } from "./index.ts";

test("the fake queue leases, reschedules and reports nextDue", async () => {
  let now = 1000;
  const q = createFakeQueue(() => now);
  const a = await q.put({ signal: "traces", body: "{}" });
  await q.put({ signal: "logs", body: "{}", leaseMillis: 500 });
  assert.equal((await q.claim(now, 10, 100)).length, 1);
  assert.equal((await q.claim(now, 10, 100)).length, 0);
  assert.ok(a);
  await q.reschedule(a.id, now + 50);
  assert.equal(await q.nextDue(), 1050);
  now = 1600;
  assert.equal((await q.claim(now, 10, 100)).length, 2);
  await q.clear();
  assert.deepEqual(await q.size(), { entries: 0, bytes: 0 });
});

test("the fake gate notifies on change only", () => {
  const gate = createFakeGate(false);
  const seen: boolean[] = [];
  gate.subscribe((r) => seen.push(r));
  gate.set(false);
  gate.set(true);
  assert.equal(gate.recording(), true);
  assert.deepEqual(seen, [true]);
});

test("the fake transport answers from its script, then ok", async () => {
  const t = createFakeTransport({ kind: "retry", reason: "429", retryAfterMillis: 1000 });
  assert.equal((await t.send({ signal: "traces", body: "{}", mode: "normal" })).kind, "retry");
  assert.equal((await t.send({ signal: "traces", body: "{}", mode: "unload" })).kind, "ok");
  assert.equal(t.requests.length, 2);
});

test("testPlatform runs core telemetry with an injected exporter", async () => {
  const exporter = new InMemorySpanExporter();
  const telemetry = await createTelemetryWith(
    { serviceName: "t", environment: "test", spanExporter: exporter, startupSummary: false },
    testPlatform(),
  );
  telemetry.tracerProvider.getTracer("t").startSpan("s").end();
  await telemetry.forceFlush();
  assert.equal(exporter.getFinishedSpans().length, 1);
  await telemetry.shutdown();
});
