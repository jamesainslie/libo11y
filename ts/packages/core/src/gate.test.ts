import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_CONTEXT, SpanKind } from "@opentelemetry/api";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  AlwaysOnSampler,
  type Sampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace";
import { gatedLogRecordProcessor, gatedSampler, gateOpen } from "./gate.ts";
import type { RecordingGate } from "./platform.ts";

function gate(open: boolean): RecordingGate & { open: boolean } {
  const g = {
    open,
    recording: () => g.open,
    subscribe: () => () => {},
  };
  return g;
}

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";

function decide(sampler: Sampler): SamplingDecision {
  return sampler.shouldSample(ROOT_CONTEXT, TRACE_ID, "s", SpanKind.INTERNAL, {}, []).decision;
}

test("gatedSampler does not record while the gate is closed and asks inner while open", () => {
  const g = gate(false);
  const calls: string[] = [];
  const inner: Sampler = {
    shouldSample: (_ctx, _traceId, name) => {
      calls.push(name);
      return { decision: SamplingDecision.RECORD_AND_SAMPLED, attributes: { "a.b": 1 } };
    },
    toString: () => "Inner",
  };
  const sampler = gatedSampler(inner, g);
  assert.equal(decide(sampler), SamplingDecision.NOT_RECORD);
  assert.deepEqual(calls, []);
  g.open = true;
  const result = sampler.shouldSample(ROOT_CONTEXT, TRACE_ID, "open", SpanKind.SERVER, {}, []);
  assert.equal(result.decision, SamplingDecision.RECORD_AND_SAMPLED);
  assert.deepEqual(result.attributes, { "a.b": 1 });
  assert.deepEqual(calls, ["open"]);
  g.open = false;
  assert.equal(decide(sampler), SamplingDecision.NOT_RECORD);
});

test("gatedSampler passes every argument through to inner", () => {
  let seen: unknown[] = [];
  const inner: Sampler = {
    shouldSample: (...args) => {
      seen = args;
      return { decision: SamplingDecision.RECORD };
    },
    toString: () => "Inner",
  };
  const links = [{ context: { traceId: TRACE_ID, spanId: "b7ad6b7169203331", traceFlags: 1 } }];
  gatedSampler(inner, gate(true)).shouldSample(
    ROOT_CONTEXT,
    TRACE_ID,
    "n",
    SpanKind.CLIENT,
    { k: "v" },
    links,
  );
  assert.deepEqual(seen, [ROOT_CONTEXT, TRACE_ID, "n", SpanKind.CLIENT, { k: "v" }, links]);
});

test("gatedSampler reports inner's name", () => {
  assert.equal(gatedSampler(new AlwaysOnSampler(), gate(true)).toString(), "AlwaysOnSampler");
  const ratio = new TraceIdRatioBasedSampler(0.25);
  assert.equal(gatedSampler(ratio, gate(false)).toString(), ratio.toString());
  assert.equal(`${gatedSampler(ratio, gate(false))}`, ratio.toString());
});

test("gateOpen is true without a gate and follows the gate otherwise", () => {
  assert.equal(gateOpen(undefined), true);
  assert.equal(gateOpen(gate(true)), true);
  assert.equal(gateOpen(gate(false)), false);
});

test("gatedLogRecordProcessor drops records and reports disabled while the gate is closed", async () => {
  const g = gate(false);
  const seen: string[] = [];
  const inner: LogRecordProcessor = {
    onEmit: (record) => {
      seen.push(String(record.body));
    },
    enabled: () => true,
    forceFlush: async () => {
      seen.push("flush");
    },
    shutdown: async () => {
      seen.push("shutdown");
    },
  };
  const p = gatedLogRecordProcessor(inner, g);
  const opts = { context: ROOT_CONTEXT, instrumentationScope: { name: "x" } };
  p.onEmit({ body: "closed" } as never);
  assert.equal(p.enabled?.(opts), false);
  g.open = true;
  p.onEmit({ body: "open" } as never);
  assert.equal(p.enabled?.(opts), true);
  g.open = false;
  await p.forceFlush();
  await p.shutdown();
  assert.deepEqual(seen, ["open", "flush", "shutdown"]);
});

test("gatedLogRecordProcessor without inner.enabled is enabled while open", () => {
  const g = gate(true);
  const inner: LogRecordProcessor = {
    onEmit: () => {},
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const p = gatedLogRecordProcessor(inner, g);
  const opts = { context: ROOT_CONTEXT, instrumentationScope: { name: "x" } };
  assert.equal(p.enabled?.(opts), true);
  g.open = false;
  assert.equal(p.enabled?.(opts), false);
});
