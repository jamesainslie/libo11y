/**
 * The recording gate wired through core: while a platform's gate is closed no span is sampled, no
 * measurement is kept and no log record reaches the OTLP leg, while the console sink still writes.
 * setupWith defers the startup canary's OTLP leg to the gate's first open.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_TELEMETRY_CONFIGURED } from "@libo11y/spec";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type MetricData,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import type { TelemetryOptions } from "./options.ts";
import type { RecordingGate } from "./platform.ts";
import { createTelemetryWith, setupWith, type Telemetry } from "./telemetry.ts";
import { createTestPlatform } from "./testing.ts";

const OPTIONS: TelemetryOptions = { serviceName: "svc", serviceVersion: "1.2.3", environment: "test" };

interface LocalGate extends RecordingGate {
  set(open: boolean): void;
  listeners(): number;
}

function localGate(open: boolean): LocalGate {
  let state = open;
  const listeners = new Set<(recording: boolean) => void>();
  return {
    recording: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      if (next === state) return;
      state = next;
      for (const l of [...listeners]) l(state);
    },
    listeners: () => listeners.size,
  };
}

function rig(gate: RecordingGate) {
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const points = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const platform = createTestPlatform({
    contextManager: () => new AsyncLocalStorageContextManager(),
    buildExporters: () => ({
      spanExporter: spans,
      logExporter: logs,
      metricReader: new PeriodicExportingMetricReader({ exporter: points, exportIntervalMillis: 3_600_000 }),
    }),
    gate,
  });
  // The data points in the last export of the application instruments whose name ends with suffix.
  const appPoints = (suffix = ""): number => {
    const all = points.getMetrics();
    const last = all[all.length - 1];
    if (last === undefined) return 0;
    return last.scopeMetrics
      .filter((sm) => sm.scope.name === "app")
      .flatMap((sm) => sm.metrics)
      .filter((m) => m.descriptor.name.endsWith(suffix))
      .reduce((n: number, m: MetricData) => n + m.dataPoints.length, 0);
  };
  const logBodies = (): unknown[] => logs.getFinishedLogRecords().map((r) => r.body);
  // The cumulative sum of the application counter name in the last export.
  const sum = (name: string): number | undefined => {
    const all = points.getMetrics();
    const metric = all[all.length - 1]?.scopeMetrics
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === name);
    return metric?.dataPoints[0]?.value as number | undefined;
  };
  return { platform, spans, logs, points, appPoints, sum, logBodies };
}

// record emits one of everything an application records.
function record(t: Telemetry, tag: string): void {
  t.tracerProvider.getTracer("app").startSpan(`span ${tag}`).end();
  const meter = t.meterProvider.getMeter("app");
  meter.createCounter(`count.${tag}`).add(1);
  meter.createUpDownCounter(`updown.${tag}`).add(-1);
  meter.createHistogram(`hist.${tag}`).record(2);
  meter.createGauge(`gauge.${tag}`).record(3);
  t.logger.info(`log ${tag}`);
  t.loggerProvider.getLogger("app").emit({ body: `api ${tag}` });
  t.event(`event.${tag}`);
}

test("a closed gate records no span, measurement or OTLP log record; the console still writes", async () => {
  const gate = localGate(false);
  const { platform, spans, appPoints, logBodies } = rig(gate);
  const t = await createTelemetryWith(OPTIONS, platform);
  try {
    let observed = 0;
    const meter = t.meterProvider.getMeter("app");
    meter.createObservableGauge("observed").addCallback((r) => {
      observed++;
      r.observe(1);
    });
    const batchGauge = meter.createObservableCounter("batch.observed");
    meter.addBatchObservableCallback(
      (r) => {
        observed++;
        r.observe(batchGauge, 1);
      },
      [batchGauge],
    );
    record(t, "closed");
    const span = t.tracerProvider.getTracer("app").startSpan("s");
    assert.equal(span.isRecording(), false);
    span.end();
    const report = await t.forceFlush();
    assert.equal(report.ok, true);
    assert.deepEqual(spans.getFinishedSpans(), []);
    assert.equal(appPoints(), 0);
    assert.equal(observed, 0, "observable callbacks are not asked while closed");
    assert.deepEqual(logBodies(), []);
    const msgs = platform.lines.map((l) => (JSON.parse(l) as { msg: string }).msg);
    assert.deepEqual(msgs, ["log closed", "event.closed"]);
  } finally {
    await t.shutdown();
  }
});

test("opening the gate records, and closing it stops recording again", async () => {
  const gate = localGate(false);
  const { platform, spans, appPoints, sum, logBodies } = rig(gate);
  const t = await createTelemetryWith(OPTIONS, platform);
  try {
    let observed = 0;
    t.meterProvider
      .getMeter("app")
      .createObservableGauge("observed")
      .addCallback((r) => {
        observed++;
        r.observe(1);
      });
    const shared = t.meterProvider.getMeter("app").createCounter("shared");
    record(t, "closed");
    gate.set(true);
    record(t, "open");
    shared.add(1);
    await t.forceFlush();
    assert.deepEqual(
      spans.getFinishedSpans().map((s) => s.name),
      ["span open"],
    );
    assert.equal(appPoints(), 6, "four synchronous instruments, the shared counter and the observable gauge");
    assert.equal(observed, 1);
    assert.deepEqual(logBodies(), ["log open", "api open", "event.open"]);

    gate.set(false);
    spans.reset();
    record(t, "closed again");
    shared.add(1);
    await t.forceFlush();
    assert.deepEqual(spans.getFinishedSpans(), []);
    assert.equal(appPoints(".closed again"), 0);
    assert.equal(sum("shared"), 1, "a measurement while closed is not kept");
    assert.equal(observed, 1);
    assert.deepEqual(logBodies(), ["log open", "api open", "event.open"]);
  } finally {
    await t.shutdown();
  }
});

test("an open gate at build records as if there were no gate", async () => {
  const { platform, spans, appPoints, logBodies } = rig(localGate(true));
  const t = await createTelemetryWith(OPTIONS, platform);
  try {
    record(t, "open");
    await t.forceFlush();
    assert.equal(spans.getFinishedSpans().length, 1);
    assert.equal(appPoints(), 4);
    assert.deepEqual(logBodies(), ["log open", "api open", "event.open"]);
  } finally {
    await t.shutdown();
  }
});

test("the summary keeps the configured sampler's name", async () => {
  const { platform } = rig(localGate(false));
  const t = await createTelemetryWith(OPTIONS, platform);
  try {
    assert.match(t.effectiveConfig(), /o11y\.config\.sampler=parentbased_always_on/);
  } finally {
    await t.shutdown();
  }
});

function canaries(bodies: readonly unknown[]): number {
  return bodies.filter((b) => b === EVENT_TELEMETRY_CONFIGURED).length;
}

test("setupWith writes the canary to the console at once and defers its OTLP leg to the first open", async () => {
  const gate = localGate(false);
  const { platform, logBodies } = rig(gate);
  const t = await setupWith(OPTIONS, platform);
  try {
    const [first] = platform.lines.map((l) => JSON.parse(l) as { msg: string });
    assert.equal(first?.msg, EVENT_TELEMETRY_CONFIGURED);
    await t.forceFlush();
    assert.equal(canaries(logBodies()), 0);

    gate.set(true);
    await t.forceFlush();
    assert.equal(canaries(logBodies()), 1);
    assert.equal(
      platform.lines.filter((l) => l.includes(EVENT_TELEMETRY_CONFIGURED)).length,
      1,
      "the deferred leg is OTLP only",
    );

    gate.set(false);
    gate.set(true);
    await t.forceFlush();
    assert.equal(canaries(logBodies()), 1, "sent once");
    assert.equal(gate.listeners(), 0, "the canary stops listening after the first open");
  } finally {
    await t.shutdown();
  }
});

test("setupWith with the gate open at setup sends the canary once, at once", async () => {
  const gate = localGate(true);
  const { platform, logBodies } = rig(gate);
  const t = await setupWith(OPTIONS, platform);
  try {
    await t.forceFlush();
    assert.equal(canaries(logBodies()), 1);
    gate.set(false);
    gate.set(true);
    await t.forceFlush();
    assert.equal(canaries(logBodies()), 1);
  } finally {
    await t.shutdown();
  }
});

test("shutdown stops waiting for the gate to open", async () => {
  const gate = localGate(false);
  const { platform } = rig(gate);
  const t = await setupWith(OPTIONS, platform);
  try {
    assert.equal(gate.listeners(), 1);
  } finally {
    await t.shutdown();
  }
  assert.equal(gate.listeners(), 0);
  gate.set(true);
});

test("startupSummary false defers nothing", async () => {
  const gate = localGate(false);
  const { platform, logBodies } = rig(gate);
  const t = await setupWith({ ...OPTIONS, startupSummary: false }, platform);
  try {
    assert.equal(gate.listeners(), 0);
    gate.set(true);
    await t.forceFlush();
    assert.equal(canaries(logBodies()), 0);
  } finally {
    await t.shutdown();
  }
});
