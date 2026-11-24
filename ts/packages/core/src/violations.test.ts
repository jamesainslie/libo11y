import assert from "node:assert/strict";
import { test } from "node:test";
import { context, ROOT_CONTEXT, TraceFlags, trace, ValueType } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { SensitivityPolicy } from "./policy.ts";
import { VERSION } from "./version.ts";
import { ViolationRecorder } from "./violations.ts";

async function collect(fn: (rec: ViolationRecorder) => void) {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const mp = new MeterProvider({ readers: [reader] });
  fn(new ViolationRecorder(mp));
  await reader.forceFlush();
  const metrics = exporter.getMetrics();
  await mp.shutdown();
  return metrics;
}

test("the counter is o11y.schema.violations with Go's unit and description on the core scope", async () => {
  const [rm] = await collect((rec) => rec.add("logs", "pii_attribute", 2));
  const [sm] = rm?.scopeMetrics ?? [];
  assert.equal(sm?.scope.name, "@libo11y/core");
  assert.equal(sm?.scope.version, VERSION);
  const [m] = sm?.metrics ?? [];
  assert.equal(m?.descriptor.name, "o11y.schema.violations");
  assert.equal(m?.descriptor.unit, "{violation}");
  assert.equal(m?.descriptor.description, "Telemetry records that violated the libo11y specification.");
  assert.equal(m?.descriptor.valueType, ValueType.INT);
  assert.equal(m?.dataPointType, DataPointType.SUM);
  const [point] = m?.dataPoints ?? [];
  assert.deepEqual(point?.attributes, { "o11y.signal": "logs", "o11y.rule": "pii_attribute" });
  assert.equal(point?.value, 2);
});

test("counts add up per signal and rule, and non-positive counts are ignored", async () => {
  const [rm] = await collect((rec) => {
    rec.add("traces", "secret_attribute", 1);
    rec.add("traces", "secret_attribute", 1);
    rec.add("resource", "identity_environment", 1);
    rec.add("logs", "pii_attribute", 0);
    rec.add("logs", "pii_attribute", -3);
  });
  const points = rm?.scopeMetrics[0]?.metrics[0]?.dataPoints ?? [];
  const byKey = Object.fromEntries(
    points.map((p) => [`${p.attributes["o11y.signal"]}/${p.attributes["o11y.rule"]}`, p.value]),
  );
  assert.deepEqual(byKey, { "traces/secret_attribute": 2, "resource/identity_environment": 1 });
});

test("counts record on the root context, never under an active span", async () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  try {
    const seen: unknown[] = [];
    const mp = {
      getMeter: () => ({
        createCounter: () => ({
          add: (_n: number, _a: unknown, ctx: unknown) => {
            seen.push(ctx);
          },
        }),
      }),
    } as never;
    const rec = new ViolationRecorder(mp);
    const span = trace.wrapSpanContext({
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      traceFlags: TraceFlags.SAMPLED,
    });
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => rec.add("logs", "pii_attribute", 1));
    assert.deepEqual(seen, [ROOT_CONTEXT]);
  } finally {
    context.disable();
  }
});

test("the policy counts through the recorder: once per span attribute, per rule", async () => {
  const [rm] = await collect((rec) => {
    const p = SensitivityPolicy.create({ pii: "drop", registries: [] }).withRecorder(rec);
    p.attributes("traces", { "host.ip": "1", "http.request.header.cookie": "c", ok: 1 });
    p.silent().attributes("traces", { "host.ip": "1" });
    p.metricAttributes({ "host.ip": "1" });
  });
  const points = rm?.scopeMetrics[0]?.metrics[0]?.dataPoints ?? [];
  const byKey = Object.fromEntries(
    points.map((p) => [`${p.attributes["o11y.signal"]}/${p.attributes["o11y.rule"]}`, p.value]),
  );
  assert.deepEqual(byKey, { "traces/pii_attribute": 1, "traces/secret_attribute": 1 });
});

test("a meter provider that cannot make the counter leaves a recorder that counts nothing", () => {
  const mp = {
    getMeter: () => {
      throw new Error("broken");
    },
  } as never;
  const rec = new ViolationRecorder(mp);
  rec.add("logs", "pii_attribute", 1);
});
