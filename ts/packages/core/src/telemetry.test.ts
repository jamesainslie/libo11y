import assert from "node:assert/strict";
import { test } from "node:test";
import { metrics, propagation, ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { globalErrorHandler } from "@opentelemetry/core";
import {
  InMemoryLogRecordExporter,
  type LogRecordExporter,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  type MetricData,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, type SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";
import { O11yError } from "./errors.ts";
import { exemplarMetricExporter, exemplarsOf } from "./exemplars.ts";
import type { TelemetryOptions } from "./options.ts";
import type { ExporterRequest, Platform, PlatformConsole } from "./platform.ts";
import { startRecord } from "./record.ts";
import { createTelemetryWith, type SignalReport, setupWith, type Telemetry } from "./telemetry.ts";
import { createTestPlatform, exemplarStoreOf } from "./testing.ts";

const OPTIONS: TelemetryOptions = { serviceName: "svc", serviceVersion: "1.2.3", environment: "test" };
const GUARD = Symbol.for("libo11y.setup");

function rig(overrides: Partial<Platform> = {}, metricExporter?: PushMetricExporter) {
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const points = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const requests: ExporterRequest[] = [];
  const platform = createTestPlatform({
    contextManager: () => new AsyncLocalStorageContextManager(),
    env: () => ({}),
    buildExporters: (req) => {
      requests.push(req);
      return {
        spanExporter: spans,
        logExporter: logs,
        metricReader: new PeriodicExportingMetricReader({
          exporter: exemplarMetricExporter(metricExporter ?? points, req.exemplars),
          exportIntervalMillis: 3_600_000,
        }),
      };
    },
    ...overrides,
  });
  const lastMetrics = (): MetricData[] => {
    const all = points.getMetrics();
    return all[all.length - 1]?.scopeMetrics.flatMap((sm) => sm.metrics) ?? [];
  };
  return { platform, spans, logs, points, requests, lastMetrics };
}

function lineObjects(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function withSetup(
  options: TelemetryOptions,
  platform: Platform,
  fn: (t: Telemetry) => Promise<void> | void,
): Promise<void> {
  const t = await setupWith(options, platform);
  try {
    await fn(t);
  } finally {
    await t.shutdown();
  }
}

test("acceptance: a span, a correlated log and an exemplar on the histogram point", async () => {
  const { platform, spans, logs, lastMetrics } = rig();
  await withSetup(OPTIONS, platform, async (t) => {
    const meter = t.meterProvider.getMeter("app");
    const histogram = meter.createHistogram("http.server.request.duration", { unit: "s" });
    let traceId = "";
    let spanId = "";
    t.tracerProvider.getTracer("app").startActiveSpan("GET /items", (span) => {
      traceId = span.spanContext().traceId;
      spanId = span.spanContext().spanId;
      t.logger.info("handling", { "http.route": "/items" });
      histogram.record(0.25, { "http.route": "/items" });
      span.end();
    });
    const report = await t.forceFlush();
    assert.deepEqual(report, { ok: true, errors: [] });

    const [span] = spans.getFinishedSpans();
    assert.equal(span?.name, "GET /items");
    assert.equal(span?.spanContext().traceId, traceId);

    const line = lineObjects(platform.lines as string[]).find((l) => l.msg === "handling");
    assert.equal(line?.trace_id, traceId);
    assert.equal(line?.span_id, spanId);

    const record = logs.getFinishedLogRecords().find((r) => r.body === "handling");
    assert.equal(record?.spanContext?.traceId, traceId);
    assert.equal(record?.spanContext?.spanId, spanId);

    const metric = lastMetrics().find((m) => m.descriptor.name === "http.server.request.duration");
    const [point] = (metric?.dataPoints ?? []) as DataPoint<unknown>[];
    assert.ok(point);
    const [exemplar] = exemplarsOf(point);
    assert.equal(exemplar?.traceId, traceId);
    assert.equal(exemplar?.spanId, spanId);
    assert.equal(exemplar?.value, 0.25);
  });
});

// Council S8: the views option reaches the exemplar store, so a renamed stream keeps its exemplars.
test("a stream the views option renames carries the span's exemplar", async () => {
  const { platform, lastMetrics } = rig();
  const views = [{ instrumentName: "app.jobs", name: "app.jobs.renamed" }];
  await withSetup({ ...OPTIONS, views }, platform, async (t) => {
    const counter = t.meterProvider.getMeter("app").createCounter("app.jobs");
    let spanId = "";
    t.tracerProvider.getTracer("app").startActiveSpan("job", (span) => {
      spanId = span.spanContext().spanId;
      counter.add(1);
      span.end();
    });
    await t.forceFlush();
    const metric = lastMetrics().find((m) => m.descriptor.name === "app.jobs.renamed");
    const [point] = (metric?.dataPoints ?? []) as DataPoint<unknown>[];
    assert.ok(point);
    assert.equal(exemplarsOf(point)[0]?.spanId, spanId);
  });
});

test("setupWith emits the canary first and installs the globals; shutdown removes them", async () => {
  const { platform } = rig();
  const t = await setupWith(OPTIONS, platform);
  try {
    const [canary] = lineObjects(platform.lines as string[]);
    assert.equal(canary?.msg, "o11y.telemetry.configured");
    assert.equal(canary?.["event.name"], "o11y.telemetry.configured");
    assert.equal(canary?.["service.name"], "svc");
    assert.equal(canary?.["o11y.config.traces"], "otlp");
    assert.equal(canary?.["o11y.config.propagators"], "traceparent,tracestate,baggage");
    assert.equal(
      t.effectiveConfig(),
      "service.name=svc service.version=1.2.3 o11y.config.traces=otlp o11y.config.metrics=otlp " +
        "o11y.config.logs=otlp o11y.config.console=json o11y.config.level=INFO " +
        "o11y.config.sampler=parentbased_always_on o11y.config.propagators=traceparent,tracestate,baggage " +
        "o11y.config.runtime_metrics=false",
    );
    assert.equal(metrics.getMeterProvider(), t.meterProvider);
    assert.deepEqual(propagation.fields(), ["traceparent", "tracestate", "baggage"]);
    assert.equal((globalThis as Record<symbol, unknown>)[GUARD], true);
    trace.getTracer("x").startActiveSpan("s", (s) => {
      assert.equal(trace.getActiveSpan(), s, "the context manager is installed");
      s.end();
    });
  } finally {
    await t.shutdown();
  }
  assert.notEqual(metrics.getMeterProvider(), t.meterProvider);
  assert.deepEqual(propagation.fields(), []);
  assert.notEqual((globalThis as Record<symbol, unknown>)[GUARD], true);
});

test("a second setupWith fails with ALREADY_SETUP until the first shuts down", async () => {
  const first = rig();
  const t = await setupWith(OPTIONS, first.platform);
  try {
    await assert.rejects(setupWith(OPTIONS, rig().platform), (err: unknown) => {
      assert.ok(err instanceof O11yError);
      assert.equal(err.code, "ALREADY_SETUP");
      assert.equal(err.message, "o11y: already set up");
      return true;
    });
  } finally {
    await t.shutdown();
  }
  const again = await setupWith(OPTIONS, rig().platform);
  await again.shutdown();
});

test("a canary rejected by the console sink fails setup with no global installed and the guard released", async () => {
  const { platform } = rig({
    writeConsoleLine: () => {
      throw new Error("stdout closed");
    },
  });
  await assert.rejects(setupWith(OPTIONS, platform), (err: unknown) => {
    assert.ok(err instanceof O11yError);
    assert.equal(err.code, "CANARY_REJECTED");
    assert.equal(err.message, "o11y: startup canary rejected by log pipeline: stdout closed");
    return true;
  });
  assert.equal(trace.setGlobalTracerProvider(new TracerProvider()), true, "no tracer provider was installed");
  trace.disable();
  assert.deepEqual(propagation.fields(), []);
  const t = await setupWith(OPTIONS, rig().platform);
  await t.shutdown();
});

test("a failing createTelemetryWith releases the guard", async () => {
  await assert.rejects(setupWith({ environment: "test" }, rig().platform), /service name required/);
  const t = await setupWith(OPTIONS, rig().platform);
  await t.shutdown();
});

test("startupSummary false emits no canary", async () => {
  const { platform } = rig();
  await withSetup({ ...OPTIONS, startupSummary: false }, platform, () => {
    assert.deepEqual(platform.lines, []);
  });
});

test("createTelemetryWith installs no global and emits no canary", async () => {
  const { platform } = rig();
  const t = await createTelemetryWith(OPTIONS, platform);
  try {
    assert.notEqual(metrics.getMeterProvider(), t.meterProvider);
    assert.deepEqual(platform.lines, []);
    assert.match(t.effectiveConfig(), /^service\.name=svc /);
    assert.equal(t.resource.attributes["service.name"], "svc");
  } finally {
    await t.shutdown();
  }
});

test("hermetic mode uses only injected exporters and never asks the platform", async () => {
  const { platform, requests } = rig();
  const spans = new InMemorySpanExporter();
  const t = await createTelemetryWith({ ...OPTIONS, hermetic: true, spanExporter: spans }, platform);
  try {
    t.tracerProvider.getTracer("t").startSpan("s").end();
    await t.forceFlush();
    assert.equal(spans.getFinishedSpans().length, 1);
    assert.equal(requests.length, 0);
    assert.match(
      t.effectiveConfig(),
      /o11y\.config\.traces=injected o11y\.config\.metrics=none o11y\.config\.logs=none/,
    );
  } finally {
    await t.shutdown();
  }
});

test("OTEL_SDK_DISABLED builds nothing but keeps the console sink", async () => {
  const { platform, requests } = rig({ env: () => ({ OTEL_SDK_DISABLED: "true" }) });
  const t = await createTelemetryWith(OPTIONS, platform);
  try {
    t.logger.info("still printed");
    assert.equal(requests.length, 0);
    assert.equal(lineObjects(platform.lines as string[])[0]?.msg, "still printed");
  } finally {
    await t.shutdown();
  }
});

test("shutdown returns the same promise to every caller and never rejects", async () => {
  const failing: PushMetricExporter = {
    export: (_m, cb) => cb({ code: 0 }),
    forceFlush: async () => {},
    shutdown: async () => {
      throw new Error("exporter broke");
    },
  };
  const { platform } = rig({}, failing);
  const t = await createTelemetryWith(OPTIONS, platform);
  const a = t.shutdown();
  const b = t.shutdown();
  assert.equal(a, b);
  const report = await a;
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.errors.map((e) => [e.signal, (e.error as Error).message]),
    [["metrics", "o11y: shutdown metrics: exporter broke"]],
  );
  assert.equal(await t.shutdown(), report);
  const dropped = lineObjects(platform.lines as string[]).find((l) => l.msg === "o11y.telemetry.dropped");
  assert.equal(dropped?.["o11y.signal"], "metrics");
  assert.equal(dropped?.["error.type"], "Error");
});

test("a hung log exporter does not starve traces, and shutdown keeps its deadline", async () => {
  const hung: LogRecordExporter = {
    export: () => {},
    forceFlush: () => new Promise<void>(() => {}),
    shutdown: () => new Promise<void>(() => {}),
  };
  const exported: string[] = [];
  const spans: SpanExporter = {
    export: (batch, cb) => {
      exported.push(...batch.map((s) => s.name));
      cb({ code: 0 });
    },
    shutdown: async () => {},
  };
  // An explicit export timeout keeps this test file quick; the child-process test below covers
  // the default.
  const { platform } = rig({ env: () => ({ OTEL_BLRP_EXPORT_TIMEOUT: "500" }) });
  const t = await createTelemetryWith({ ...OPTIONS, spanExporter: spans, logExporter: hung }, platform);
  t.tracerProvider.getTracer("t").startSpan("kept").end();
  t.logger.info("stuck");
  const started = Date.now();
  const report = await t.shutdown({ timeoutMillis: 300 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `shutdown took ${elapsed} ms`);
  assert.deepEqual(
    report.errors.map((e) => [e.signal, (e.error as Error).message]),
    [["logs", "o11y: shutdown logs: deadline exceeded"]],
  );
  assert.deepEqual(exported, ["kept"]);
  const dropped = lineObjects(platform.lines as string[]).filter((l) => l.msg === "o11y.telemetry.dropped");
  assert.deepEqual(
    dropped.map((d) => [d["o11y.signal"], d["error.type"]]),
    [["logs", "TimeoutError"]],
  );
});

test("shutdown's dropped event names the class of what the signal failed with, not the wrapper's", async () => {
  class ExporterBroke extends Error {}
  const failing: PushMetricExporter = {
    export: (_m, cb) => cb({ code: 0 }),
    forceFlush: async () => {},
    shutdown: async () => {
      throw new ExporterBroke("exporter broke at secret-host");
    },
  };
  const { platform } = rig({}, failing);
  const t = await createTelemetryWith(OPTIONS, platform);
  const report = await t.shutdown();
  assert.deepEqual(
    report.errors.map((e) => [e.signal, (e.error as Error).message]),
    [["metrics", "o11y: shutdown metrics: exporter broke at secret-host"]],
  );
  const dropped = lineObjects(platform.lines as string[]).filter((l) => l.msg === "o11y.telemetry.dropped");
  assert.deepEqual(
    dropped.map((d) => [d["o11y.signal"], d["error.type"]]),
    [["metrics", "ExporterBroke"]],
  );
  assert.doesNotMatch(JSON.stringify(dropped), /secret-host/);
});

test("forceFlush reports each failing signal in order", async () => {
  const failing: PushMetricExporter = {
    export: (_m, cb) => cb({ code: 0 }),
    forceFlush: async () => {
      throw new Error("collector down");
    },
    shutdown: async () => {},
  };
  const { platform } = rig({}, failing);
  const t = await createTelemetryWith(OPTIONS, platform);
  try {
    t.meterProvider.getMeter("m").createCounter("c").add(1);
    const report = await t.forceFlush();
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.errors.map((e) => e.signal),
      ["metrics"],
    );
    assert.equal(
      (report.errors[0]?.error as Error | undefined)?.message,
      "o11y: flush metrics: collector down",
    );
  } finally {
    await t.shutdown();
  }
});

test("a global registered by someone else is reported through the error handler and setup continues", async () => {
  const theirs = new TracerProvider();
  assert.equal(trace.setGlobalTracerProvider(theirs), true);
  const { platform } = rig();
  try {
    await withSetup(OPTIONS, platform, (t) => {
      assert.ok(
        platform.diagnostics.some(
          (l) => l.includes('msg="o11y: telemetry error"') && l.includes("tracer provider"),
        ),
        platform.diagnostics.join("\n"),
      );
      assert.equal(metrics.getMeterProvider(), t.meterProvider);
      t.tracerProvider.getTracer("t").startSpan("works").end();
    });
  } finally {
    trace.disable();
  }
});

test("the error handler is rate limited to a burst of 5", async () => {
  const { platform } = rig();
  await withSetup(OPTIONS, platform, () => {
    for (let i = 0; i < 8; i++) globalErrorHandler(new Error(`e${i}`));
    const lines = platform.diagnostics.filter((l) => l.includes("o11y: telemetry error"));
    assert.equal(lines.length, 5);
    assert.match(lines[0] ?? "", /^time=\S+ level=WARN msg="o11y: telemetry error" error=e0$/);
  });
});

test("event force-emits at info with event.name first", async () => {
  const { platform } = rig();
  const t = await createTelemetryWith({ ...OPTIONS, logLevel: "error" }, platform);
  try {
    t.event("my.event", { k: "v", "event.name": "spoof" });
    const [line] = lineObjects(platform.lines as string[]);
    assert.equal(line?.level, "INFO");
    assert.deepEqual(Object.keys(line ?? {}).slice(3), ["event.name", "k"]);
    assert.equal(line?.["event.name"], "my.event");
  } finally {
    await t.shutdown();
  }
});

test("captureConsole routes the platform console into the logger until shutdown", async () => {
  const calls: unknown[][] = [];
  const target: PlatformConsole = {
    log: (...a) => void calls.push(a),
    info: (...a) => void calls.push(a),
    warn: (...a) => void calls.push(a),
    error: (...a) => void calls.push(a),
    debug: (...a) => void calls.push(a),
    trace: (...a) => void calls.push(a),
  };
  const { platform } = rig({ console: target });
  const t = await createTelemetryWith({ ...OPTIONS, captureConsole: true }, platform);
  target.log("captured %d", 1);
  await t.shutdown();
  target.log("after");
  assert.equal(lineObjects(platform.lines as string[])[0]?.msg, "captured 1");
  assert.deepEqual(calls, [["after"]]);
});

test("the PII key is checked before the registries", async () => {
  await assert.rejects(
    createTelemetryWith({ ...OPTIONS, piiMode: "hash", registry: { bogus: true } as never }, rig().platform),
    (err: unknown) => err instanceof O11yError && err.code === "PII_HASH_KEY",
  );
});

test("a step after the meter provider that throws shuts down what was built", async () => {
  let readerShutdown = false;
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 3_600_000,
  });
  const original = reader.shutdown.bind(reader);
  reader.shutdown = async (o) => {
    readerShutdown = true;
    await original(o);
  };
  const { platform } = rig({
    startRuntimeMetrics: () => {
      throw new Error("boom");
    },
  });
  await assert.rejects(
    createTelemetryWith({ ...OPTIONS, runtimeMetrics: true, metricReader: reader }, platform),
    /^Error: o11y: starting runtime metrics: boom$/,
  );
  assert.equal(readerShutdown, true);
});

test("runtime metrics start on the policy meter provider and stop at shutdown", async () => {
  let stopped = false;
  let given: unknown;
  const { platform } = rig({
    startRuntimeMetrics: (mp) => {
      given = mp;
      return {
        stop: () => {
          stopped = true;
        },
      };
    },
  });
  const t = await createTelemetryWith({ ...OPTIONS, runtimeMetrics: true }, platform);
  assert.equal(given, t.meterProvider);
  assert.match(t.effectiveConfig(), /o11y\.config\.runtime_metrics=true/);
  await t.shutdown();
  assert.equal(stopped, true);
});

test("runtime metrics stop after the final collection, so a process that exits before any export keeps them", async () => {
  const order: string[] = [];
  const { platform, points, lastMetrics } = rig({
    startRuntimeMetrics: (mp) => {
      const gauge = mp.getMeter("runtime").createObservableGauge("runtime.probe");
      const observe = (result: { observe(v: number): void }): void => {
        order.push("collect");
        result.observe(1);
      };
      gauge.addCallback(observe);
      return {
        stop: () => {
          order.push("stop");
          gauge.removeCallback(observe);
        },
      };
    },
  });
  const t = await createTelemetryWith({ ...OPTIONS, runtimeMetrics: true }, platform);
  // The reader's interval is an hour, so the only export is shutdown's final collection.
  await t.shutdown();
  assert.ok(points.getMetrics().length > 0, "shutdown exported nothing");
  assert.ok(
    lastMetrics().some((m) => m.descriptor.name === "runtime.probe" && m.dataPoints.length > 0),
    `no runtime.probe in the final export: ${lastMetrics()
      .map((m) => m.descriptor.name)
      .join(", ")}`,
  );
  assert.deepEqual(order, ["collect", "stop"]);
});

test("non-strict identity counts resource violations on o11y.schema.violations", async () => {
  const { platform, lastMetrics } = rig();
  const t = await createTelemetryWith({ serviceName: "svc", strictIdentity: false }, platform);
  try {
    await t.forceFlush();
    const metric = lastMetrics().find((m) => m.descriptor.name === "o11y.schema.violations");
    const points = (metric?.dataPoints ?? []) as DataPoint<number>[];
    assert.deepEqual(
      points.map((p) => [p.attributes["o11y.signal"], p.attributes["o11y.rule"], p.value]),
      [["resource", "identity_environment", 1]],
    );
  } finally {
    await t.shutdown();
  }
});

test("review C1: an empty-keyed group cannot leak through setup's sinks, with console capture on", async () => {
  const calls: unknown[][] = [];
  const target: PlatformConsole = {
    log: (...a) => void calls.push(a),
    info: (...a) => void calls.push(a),
    warn: (...a) => void calls.push(a),
    error: (...a) => void calls.push(a),
    debug: (...a) => void calls.push(a),
    trace: (...a) => void calls.push(a),
  };
  const { platform, logs } = rig({ console: target });
  const t = await createTelemetryWith({ ...OPTIONS, captureConsole: true }, platform);
  try {
    t.logger.info("m", {
      "": { "http.request.header.authorization": "Bearer SECRET", "host.ip": "1.2.3.4" },
    } as never);
    t.logger.info("m2", { http: { "": { "request.header.authorization": "Bearer SECRET2" } } } as never);
    target.error("captured", new Error("boom"));
    await t.forceFlush();
    const all = `${platform.lines.join("\n")}\n${JSON.stringify(logs.getFinishedLogRecords().map((r) => r.attributes))}`;
    for (const leaked of ["SECRET", "1.2.3.4"]) assert.ok(!all.includes(leaked), `${leaked} leaked:\n${all}`);
    assert.equal(logs.getFinishedLogRecords().length, 3);
    assert.deepEqual(calls, []);
  } finally {
    await t.shutdown();
  }
});

test("review W1: two capturing telemetries shut down in creation order leave the console native", async () => {
  const calls: unknown[][] = [];
  const mk =
    () =>
    (...a: unknown[]) =>
      void calls.push(a);
  const target: PlatformConsole = {
    log: mk(),
    info: mk(),
    warn: mk(),
    error: mk(),
    debug: mk(),
    trace: mk(),
  };
  const a = rig({ console: target });
  const b = rig({ console: target });
  const opts = { ...OPTIONS, hermetic: true, captureConsole: true };
  const ta = await createTelemetryWith(opts, a.platform);
  const tb = await createTelemetryWith(opts, b.platform);
  await ta.shutdown();
  target.log("while B runs");
  await tb.shutdown();
  target.log("after both shutdowns");
  assert.deepEqual(calls, [["after both shutdowns"]]);
  assert.equal(b.platform.lines.length, 1);
  assert.equal(a.platform.lines.length, 0);
});

test("review W3: a throw while installing globals uninstalls, shuts down and releases the guard", async () => {
  let exporterShutdown = false;
  const spans: SpanExporter = {
    export: (_b, cb) => cb({ code: 0 }),
    shutdown: async () => {
      exporterShutdown = true;
    },
  };
  const broken = {
    enable: () => {
      throw new Error("no async context here");
    },
  } as unknown as ReturnType<Platform["contextManager"]>;
  const { platform } = rig({ contextManager: () => broken });
  await assert.rejects(setupWith({ ...OPTIONS, spanExporter: spans }, platform), /no async context here/);
  assert.equal(exporterShutdown, true);
  assert.notEqual((globalThis as Record<symbol, unknown>)[GUARD], true);
  assert.equal(
    trace.setGlobalTracerProvider(new TracerProvider()),
    true,
    "no tracer provider stayed installed",
  );
  trace.disable();
  assert.deepEqual(propagation.fields(), []);
  const t = await setupWith(OPTIONS, rig().platform);
  await t.shutdown();
});

function sampledContext() {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: TraceFlags.SAMPLED,
  });
}

// Review W5a: with metrics off nothing can read the store, so it samples nothing.
test("with metrics routed to none the exemplar store samples nothing", async () => {
  const t = await createTelemetryWith({ ...OPTIONS, hermetic: true }, rig().platform);
  try {
    t.meterProvider.getMeter("app").createCounter("c").add(1, {}, sampledContext());
    const rm = {
      resource: t.resource,
      scopeMetrics: [
        {
          scope: { name: "app", version: "" },
          metrics: [
            {
              descriptor: { name: "c", description: "", unit: "", valueType: 1 },
              aggregationTemporality: AggregationTemporality.CUMULATIVE,
              dataPointType: 3,
              isMonotonic: true,
              dataPoints: [
                { startTime: [0, 0], endTime: [Date.now() / 1000 + 10, 0], attributes: {}, value: 1 },
              ],
            },
          ],
        },
      ],
    } as unknown as ResourceMetrics;
    const [point] = (exemplarStoreOf(t).attach(rm).scopeMetrics[0]?.metrics[0]?.dataPoints ??
      []) as DataPoint<unknown>[];
    assert.deepEqual(exemplarsOf(point as DataPoint<unknown>), []);
  } finally {
    await t.shutdown();
  }
});

// Review W5b: an injected reader is used as is; a harness attaches exemplars through the testing
// subpath's exemplarStoreOf.
test("an injected log processor sees each classified record synchronously, with its context", async () => {
  const seen: { body: unknown; attributes: Record<string, unknown>; traceId: string | undefined }[] = [];
  let shutdowns = 0;
  const logProcessor: LogRecordProcessor = {
    onEmit: (record, ctx) =>
      seen.push({
        body: record.body,
        attributes: { ...record.attributes },
        traceId: ctx === undefined ? undefined : trace.getSpanContext(ctx)?.traceId,
      }),
    forceFlush: async () => {},
    shutdown: async () => {
      shutdowns++;
    },
  };
  const logs = new InMemoryLogRecordExporter();
  const t = await createTelemetryWith(
    { ...OPTIONS, hermetic: true, console: false, logProcessor, logExporter: logs },
    rig().platform,
  );
  try {
    const span = t.tracerProvider.getTracer("app").startSpan("op");
    t.event(
      "hello",
      { "http.request.header.authorization": "Bearer x", "app.ok": 1 },
      trace.setSpan(ROOT_CONTEXT, span),
    );
    span.end();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.body, "hello");
    assert.deepEqual(seen[0]?.attributes, { "event.name": "hello", "app.ok": 1 });
    assert.match(seen[0]?.traceId ?? "", /^[0-9a-f]{32}$/);
    assert.match(t.effectiveConfig(), /o11y\.config\.logs=injected/);
    await t.forceFlush();
    assert.equal(logs.getFinishedLogRecords().length, 1);
  } finally {
    await t.shutdown();
  }
  assert.equal(shutdowns, 1);
});

// A log processor is one more leg beside the log exporter, as Go's WithExtraLogHandler is beside
// the OTLP leg. It used to make the log route "injected", so the platform's log exporter was never
// used, and logExport false dropped it.
function bodiesProcessor() {
  const bodies: unknown[] = [];
  let shutdowns = 0;
  const processor: LogRecordProcessor = {
    onEmit: (record) => void bodies.push(record.body),
    forceFlush: async () => {},
    shutdown: async () => {
      shutdowns++;
    },
  };
  return { processor, bodies, shutdowns: () => shutdowns };
}

test("a log processor alone runs beside the platform's log exporter, and both get every record", async () => {
  const { platform, logs } = rig();
  const p = bodiesProcessor();
  const t = await createTelemetryWith(
    { ...OPTIONS, console: false, startupSummary: false, logProcessor: p.processor },
    platform,
  );
  try {
    t.logger.info("one");
    t.logger.warn("two");
    await t.forceFlush();
    assert.deepEqual(p.bodies, ["one", "two"]);
    assert.deepEqual(
      logs.getFinishedLogRecords().map((r) => r.body),
      ["one", "two"],
    );
    // The summary describes the exporter route, not the processor.
    assert.match(t.effectiveConfig(), /o11y\.config\.logs=otlp/);
  } finally {
    await t.shutdown();
  }
  assert.equal(p.shutdowns(), 1);
});

test("with logExport false a log processor still gets every record, and nothing is exported", async () => {
  const { platform, logs } = rig();
  const p = bodiesProcessor();
  const t = await createTelemetryWith(
    { ...OPTIONS, console: false, startupSummary: false, logExport: false, logProcessor: p.processor },
    platform,
  );
  try {
    t.logger.info("one");
    await t.forceFlush();
    assert.deepEqual(p.bodies, ["one"]);
    assert.deepEqual(logs.getFinishedLogRecords(), []);
    assert.match(t.effectiveConfig(), /o11y\.config\.logs=none/);
  } finally {
    await t.shutdown();
  }
  assert.equal(p.shutdowns(), 1);
});

test("in hermetic mode a log processor alone gets every record, classified, with no exporter", async () => {
  const { platform, logs, requests } = rig();
  const p = bodiesProcessor();
  const attrs: Record<string, unknown>[] = [];
  const processor: LogRecordProcessor = {
    ...p.processor,
    onEmit: (record, ctx) => {
      p.processor.onEmit(record, ctx);
      attrs.push({ ...record.attributes });
    },
  };
  const t = await createTelemetryWith(
    { ...OPTIONS, hermetic: true, console: false, startupSummary: false, logProcessor: processor },
    platform,
  );
  try {
    t.logger.info("one", { "http.request.header.authorization": "Bearer x", ok: 1 });
    await t.forceFlush();
    assert.deepEqual(p.bodies, ["one"]);
    assert.deepEqual(attrs, [{ ok: 1 }]);
    assert.deepEqual(logs.getFinishedLogRecords(), []);
    assert.deepEqual(requests, []);
    assert.match(t.effectiveConfig(), /o11y\.config\.logs=none/);
  } finally {
    await t.shutdown();
  }
  assert.equal(p.shutdowns(), 1);
});

test("OTEL_SDK_DISABLED keeps an injected log processor off", async () => {
  const { platform } = rig({ env: () => ({ OTEL_SDK_DISABLED: "true" }) });
  const p = bodiesProcessor();
  const t = await createTelemetryWith(
    { ...OPTIONS, console: false, startupSummary: false, logProcessor: p.processor },
    platform,
  );
  try {
    t.logger.info("one");
    await t.forceFlush();
    assert.deepEqual(p.bodies, []);
  } finally {
    await t.shutdown();
  }
});

test("exemplarStoreOf lets a harness attach exemplars to an injected reader's collection", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const t = await createTelemetryWith({ ...OPTIONS, hermetic: true, metricReader: reader }, rig().platform);
  try {
    t.meterProvider.getMeter("app").createHistogram("h").record(2, {}, sampledContext());
    const { resourceMetrics } = await reader.collect();
    const attached = exemplarStoreOf(t).attach(resourceMetrics);
    const metric = attached.scopeMetrics.flatMap((sm) => sm.metrics).find((m) => m.descriptor.name === "h");
    const [point] = (metric?.dataPoints ?? []) as DataPoint<unknown>[];
    assert.equal(exemplarsOf(point as DataPoint<unknown>)[0]?.traceId, "0af7651916cd43dd8448eb211c80319c");
  } finally {
    await t.shutdown();
  }
  assert.throws(() => exemplarStoreOf({} as Telemetry), TypeError);
});

function slowSpanExporter(ms: number): SpanExporter {
  return {
    export: (_b, cb) => cb({ code: 0 }),
    shutdown: () => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
}

test("timeoutMillis is clamped: Infinity is the timer maximum, a negative value is zero", async () => {
  const forever = await createTelemetryWith(
    { ...OPTIONS, hermetic: true, spanExporter: slowSpanExporter(50) },
    rig().platform,
  );
  assert.deepEqual(await forever.shutdown({ timeoutMillis: Number.POSITIVE_INFINITY }), {
    ok: true,
    errors: [],
  });
  const flushed = await createTelemetryWith({ ...OPTIONS, hermetic: true }, rig().platform);
  assert.deepEqual(await flushed.forceFlush({ timeoutMillis: 2 ** 40 }), { ok: true, errors: [] });
  await flushed.shutdown();
  const none = await createTelemetryWith(
    { ...OPTIONS, hermetic: true, spanExporter: slowSpanExporter(50) },
    rig().platform,
  );
  const report = await none.shutdown({ timeoutMillis: -5 });
  assert.deepEqual(
    report.errors.map((e) => [e.signal, (e.error as Error).message]),
    [["traces", "o11y: shutdown traces: deadline exceeded"]],
  );
});

test("an unexpected shutdown failure is reported on the lifecycle signal and still releases the guard", async () => {
  const t = await setupWith({ ...OPTIONS, startupSummary: false }, rig().platform);
  const g = globalThis as unknown as { setTimeout: unknown };
  const saved = g.setTimeout;
  g.setTimeout = () => {
    throw new Error("no timers");
  };
  let pending: Promise<SignalReport>;
  let flushed: Promise<SignalReport>;
  try {
    flushed = t.forceFlush();
    pending = t.shutdown();
  } finally {
    g.setTimeout = saved;
  }
  assert.deepEqual(
    (await flushed).errors.map((e) => e.signal),
    ["lifecycle"],
  );
  const report = await pending;
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.errors.map((e) => [e.signal, (e.error as Error).message]),
    [["lifecycle", "no timers"]],
  );
  assert.notEqual((globalThis as Record<symbol, unknown>)[GUARD], true);
  assert.notEqual(metrics.getMeterProvider(), t.meterProvider);
});

// Site review: nothing the logger or event is given may throw into the host. What is dropped is
// reported through the telemetry's rate-limited error handler, on the diagnostic stream.
function revokedProxy(): never {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy as never;
}

const boomReplacer: NonNullable<TelemetryOptions["attrReplacer"]> = (key, value) => {
  if (key === "boom") throw new Error("replacer boom");
  return [key, value];
};

function errorLines(platform: { readonly diagnostics: readonly string[] }): string[] {
  return platform.diagnostics.filter((l) => l.includes('msg="o11y: telemetry error"'));
}

test("the logger, child and event never throw: what they drop is reported on the diagnostic stream", async () => {
  const { platform } = rig();
  const t = await createTelemetryWith({ ...OPTIONS, attrReplacer: boomReplacer }, platform);
  try {
    assert.doesNotThrow(() => t.logger.info("unredacted", { boom: 1 }));
    assert.doesNotThrow(() => t.event("o11y.custom", revokedProxy()));
    assert.doesNotThrow(() => t.event("o11y.custom.dropped", { boom: 1 }));
    assert.doesNotThrow(() => t.logger.child(revokedProxy()).warn("kept"));
    const lines = lineObjects(platform.lines as string[]);
    assert.deepEqual(
      lines.map((l) => l.msg),
      ["o11y.custom", "kept"],
    );
    assert.equal(lines[0]?.["event.name"], "o11y.custom");
    const errors = errorLines(platform);
    assert.equal(errors.length, 4, errors.join("\n"));
    assert.match(
      errors[0] ?? "",
      /^time=\S+ level=WARN msg="o11y: telemetry error" error="o11y: attrReplacer failed on \\"boom\\", the INFO record is dropped: Error"$/,
    );
    assert.match(errors[1] ?? "", /error="o11y: log attributes cannot be read and are dropped: TypeError"$/);
  } finally {
    await t.shutdown();
  }
});

// Second review: the logger and the exporters each have a rate limit of their own, so a getter that
// fails on a hot path cannot use up the lines an exporter failure needs.
test("logger failures and exporter errors are rate limited separately", async () => {
  const { platform } = rig();
  await withSetup({ ...OPTIONS, attrReplacer: boomReplacer }, platform, (t) => {
    for (let i = 0; i < 20; i++) t.logger.info("unredacted", { boom: i });
    assert.equal(errorLines(platform).length, 5, "the logger's own burst");
    for (let i = 0; i < 20; i++) globalErrorHandler(new Error(`e${i}`));
    const errors = errorLines(platform);
    assert.equal(errors.length, 10, errors.join("\n"));
    assert.match(errors[5] ?? "", /error=e0$/);
    assert.match(errors[9] ?? "", /error=e4$/);
    assert.ok(!platform.lines.some((l) => l.includes("unredacted")));

    // The handle's reporter, which instrumentation built on core uses, has a third.
    const report = (t as unknown as Record<symbol, unknown>)[Symbol.for("libo11y.report")];
    assert.equal(typeof report, "function");
    for (let i = 0; i < 20; i++) (report as (err: unknown) => void)(new Error(`r${i}`));
    const all = errorLines(platform);
    assert.equal(all.length, 15, all.join("\n"));
    assert.match(all[10] ?? "", /error=r0$/);
  });
});

// Second review, W2: the diagnostic stream never gets the message of what a hook threw.
test("nothing a replacer or a getter throws reaches the diagnostic stream by its message", async () => {
  const marker = "tok_MARKER_51Habc";
  const { platform } = rig();
  const t = await createTelemetryWith(
    {
      ...OPTIONS,
      attrReplacer: (key, value) =>
        key === "callback" ? [key, new URL(String(value)).origin] : [key, value],
    },
    platform,
  );
  try {
    t.logger.error("payment failed", { callback: marker, amount: 12 });
    t.logger.info("lookup", {
      get user(): string {
        throw new Error(`no row for ${marker}`);
      },
    });
    t.event("o11y.custom", { callback: `${marker} again` });
    const errors = errorLines(platform);
    assert.equal(errors.length, 3, errors.join("\n"));
    assert.match(
      errors[0] ?? "",
      /error="o11y: attrReplacer failed on \\"callback\\", the ERROR record is dropped: TypeError"$/,
    );
    assert.match(
      errors[1] ?? "",
      /error="o11y: log attribute \\"user\\" cannot be read and is dropped: Error"$/,
    );
    const everything = [...platform.diagnostics, ...platform.lines].join("\n");
    assert.ok(!everything.includes("MARKER"), everything);
  } finally {
    await t.shutdown();
  }
});

test("a replacer that throws on the startup canary still fails setup with CANARY_REJECTED", async () => {
  const { platform } = rig();
  await assert.rejects(
    setupWith(
      {
        ...OPTIONS,
        attrReplacer: () => {
          throw new Error("replacer boom");
        },
      },
      platform,
    ),
    (err: unknown) =>
      err instanceof O11yError && err.code === "CANARY_REJECTED" && /replacer boom/.test(err.message),
  );
  assert.equal((globalThis as Record<symbol, unknown>)[GUARD], undefined);
});

// Site review: upstream's batch log processor and periodic reader hand a failed export to the
// error handler and resolve, so shutdown and forceFlush used to report ok while telemetry was lost.
function refusing(calls: { exports: number; shutdowns: number }, healthy = { value: false }) {
  return {
    export: (_items: unknown, cb: (result: { code: number; error?: Error }) => void): void => {
      calls.exports++;
      cb(healthy.value ? { code: 0 } : { code: 1, error: new Error("Not Found") });
    },
    forceFlush: async (): Promise<void> => {},
    shutdown: async (): Promise<void> => {
      calls.shutdowns++;
    },
  };
}

function emitOnEverySignal(t: Telemetry): void {
  t.tracerProvider.getTracer("t").startSpan("s").end();
  t.logger.info("l");
  t.meterProvider.getMeter("m").createCounter("c").add(1);
}

test("shutdown reports every signal whose final export failed, and says each one was dropped", async () => {
  const calls = { exports: 0, shutdowns: 0 };
  const exporter = refusing(calls);
  const { platform } = rig({}, exporter as PushMetricExporter);
  const t = await createTelemetryWith(
    { ...OPTIONS, spanExporter: exporter as SpanExporter, logExporter: exporter as LogRecordExporter },
    platform,
  );
  emitOnEverySignal(t);
  const report = await t.shutdown();
  assert.equal(calls.exports, 3);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.errors.map((e) => [e.signal, (e.error as Error).message]),
    [
      ["logs", "o11y: shutdown logs: Not Found"],
      ["metrics", "o11y: shutdown metrics: Not Found"],
      ["traces", "o11y: shutdown traces: Not Found"],
    ],
  );
  const dropped = lineObjects(platform.lines as string[]).filter((l) => l.msg === "o11y.telemetry.dropped");
  assert.deepEqual(
    dropped.map((d) => d["o11y.signal"]),
    ["logs", "metrics", "traces"],
  );
});

test("forceFlush reports every signal whose export failed, and only for the flush that failed", async () => {
  const calls = { exports: 0, shutdowns: 0 };
  const healthy = { value: false };
  const exporter = refusing(calls, healthy);
  const { platform } = rig({}, exporter as PushMetricExporter);
  const t = await createTelemetryWith(
    { ...OPTIONS, spanExporter: exporter as SpanExporter, logExporter: exporter as LogRecordExporter },
    platform,
  );
  try {
    emitOnEverySignal(t);
    const failed = await t.forceFlush();
    // The tracer provider rejects with a list of errors, which reads "Error: Not Found".
    assert.deepEqual(
      failed.errors.map((e) => [e.signal, (e.error as Error).message]),
      [
        ["logs", "o11y: flush logs: Not Found"],
        ["metrics", "o11y: flush metrics: Not Found"],
        ["traces", "o11y: flush traces: Error: Not Found"],
      ],
    );
    healthy.value = true;
    emitOnEverySignal(t);
    assert.deepEqual(await t.forceFlush(), { ok: true, errors: [] });
  } finally {
    assert.deepEqual(await t.shutdown(), { ok: true, errors: [] });
  }
});

test("an export that throws is a failed export, not a crash", async () => {
  const throwing: LogRecordExporter = {
    export: () => {
      throw new Error("serializer broke");
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const { platform } = rig();
  const t = await createTelemetryWith({ ...OPTIONS, logExporter: throwing }, platform);
  t.logger.info("l");
  const report = await t.shutdown();
  assert.deepEqual(
    report.errors.map((e) => [e.signal, (e.error as Error).message]),
    [["logs", "o11y: shutdown logs: serializer broke"]],
  );
});

test("when the deadline passes, an exporter still exporting is stopped and its export is failed", async () => {
  let shutdowns = 0;
  const hung: SpanExporter = {
    export: () => {},
    shutdown: async () => {
      shutdowns++;
    },
  };
  const { platform } = rig();
  const t = await createTelemetryWith({ ...OPTIONS, spanExporter: hung }, platform);
  t.tracerProvider.getTracer("t").startSpan("stuck").end();
  const report = await t.shutdown({ timeoutMillis: 50 });
  assert.deepEqual(
    report.errors.map((e) => [e.signal, (e.error as Error).message]),
    [["traces", "o11y: shutdown traces: deadline exceeded"]],
  );
  assert.equal(shutdowns, 1, "the exporter is told to stop once the deadline has passed");
});

// OTEL_PROPAGATORS, for parity with Go.
function withPropagators(named: string, overrides: Partial<Platform> = {}) {
  return rig({ env: () => ({ OTEL_PROPAGATORS: named }), ...overrides });
}

const SPAN_CTX = propagation.setBaggage(
  trace.setSpanContext(ROOT_CONTEXT, {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: TraceFlags.SAMPLED,
  }),
  propagation.createBaggage({ keep: { value: "1" }, secret: { value: "2" } }),
);

function injected(t: Telemetry): Record<string, string> {
  const carrier: Record<string, string> = {};
  t.propagator.inject(SPAN_CTX, carrier, {
    set: (c: Record<string, string>, k: string, v: string) => {
      c[k] = v;
    },
  });
  return carrier;
}

test("OTEL_PROPAGATORS selects the propagators, in its order, on the handle, the canary and the config line", async () => {
  const { platform } = withPropagators(" baggage , tracecontext ");
  await withSetup(OPTIONS, platform, (t) => {
    assert.deepEqual(t.propagator.fields(), ["baggage", "traceparent", "tracestate"]);
    assert.deepEqual(Object.keys(injected(t)), ["baggage", "traceparent"]);
    assert.match(t.effectiveConfig(), / o11y\.config\.propagators=baggage,traceparent,tracestate /);
    const [canary] = lineObjects(platform.lines as string[]);
    assert.equal(canary?.["o11y.config.propagators"], "baggage,traceparent,tracestate");
    assert.deepEqual(propagation.fields(), ["baggage", "traceparent", "tracestate"]);
  });
});

test("OTEL_PROPAGATORS=tracecontext sends no baggage, and none sends nothing and is reported as none", async () => {
  const tc = await createTelemetryWith(OPTIONS, withPropagators("tracecontext").platform);
  const none = await createTelemetryWith(OPTIONS, withPropagators("none").platform);
  try {
    assert.deepEqual(Object.keys(injected(tc)), ["traceparent"]);
    assert.match(tc.effectiveConfig(), / o11y\.config\.propagators=traceparent,tracestate /);
    assert.deepEqual(injected(none), {});
    assert.match(none.effectiveConfig(), / o11y\.config\.propagators=none /);
  } finally {
    await tc.shutdown();
    await none.shutdown();
  }
});

test("the baggage egress filter still wraps what OTEL_PROPAGATORS selects", async () => {
  const { seams } = await import("./internal/seams.ts");
  seams.baggageEgress = (key) => key !== "secret";
  let t: Telemetry;
  try {
    t = await createTelemetryWith(OPTIONS, withPropagators("baggage").platform);
  } finally {
    seams.baggageEgress = undefined;
  }
  try {
    assert.deepEqual(injected(t), { baggage: "keep=1" });
  } finally {
    await t.shutdown();
  }
});

test("a propagator the packages do not ship fails createTelemetryWith and setupWith with UNSUPPORTED_PROPAGATOR", async () => {
  const unsupported = (err: unknown): boolean =>
    err instanceof O11yError &&
    err.code === "UNSUPPORTED_PROPAGATOR" &&
    err.message ===
      'o11y: unsupported propagator "b3" in OTEL_PROPAGATORS: use tracecontext, baggage or none, or pass the propagators option';
  await assert.rejects(
    createTelemetryWith(OPTIONS, withPropagators("tracecontext,b3").platform),
    unsupported,
  );
  await assert.rejects(setupWith(OPTIONS, withPropagators("tracecontext,b3").platform), unsupported);
  assert.equal((globalThis as Record<symbol, unknown>)[GUARD], undefined, "setup gave the guard back");
});

test("the propagators option beats OTEL_PROPAGATORS, and hermetic mode never reads it", async () => {
  const custom = {
    inject: (_ctx: unknown, carrier: unknown) => {
      (carrier as Record<string, string>)["x-custom"] = "1";
    },
    extract: <T>(ctx: T): T => ctx,
    fields: () => ["x-custom"],
  };
  const withOption = await createTelemetryWith(
    { ...OPTIONS, propagators: [custom as never] },
    withPropagators("b3").platform,
  );
  const hermetic = await createTelemetryWith({ ...OPTIONS, hermetic: true }, withPropagators("b3").platform);
  // An empty option is no option, as in Go: the variable applies.
  const empty = await createTelemetryWith(
    { ...OPTIONS, propagators: [] },
    withPropagators("baggage").platform,
  );
  // A propagator that names no fields is reported as "custom", as Go reports it, never as nothing.
  const fieldless = await createTelemetryWith(
    { ...OPTIONS, propagators: [{ ...custom, fields: () => [] } as never] },
    withPropagators("b3").platform,
  );
  try {
    assert.match(fieldless.effectiveConfig(), / o11y\.config\.propagators=custom /);
    assert.deepEqual(injected(fieldless), { "x-custom": "1" }, "it still propagates");
    assert.deepEqual(injected(withOption), { "x-custom": "1" });
    assert.match(withOption.effectiveConfig(), / o11y\.config\.propagators=x-custom /);
    assert.deepEqual(hermetic.propagator.fields(), ["traceparent", "tracestate", "baggage"]);
    assert.match(hermetic.effectiveConfig(), / o11y\.config\.propagators=traceparent,tracestate,baggage /);
    assert.deepEqual(empty.propagator.fields(), ["baggage"]);
  } finally {
    await fieldless.shutdown();
    await withOption.shutdown();
    await hermetic.shutdown();
    await empty.shutdown();
  }
});

// Second review: a deadline that is not a number. A string that reads as a finite number is taken
// as that number, as it always was. Anything else is the default, where it used to arm a timer
// with NaN, which fires after a millisecond.
test("timeoutMillis that is not a number: a numeric string is that number, anything else is the default", async () => {
  for (const [given, expires] of [
    ["abc", false],
    [null, false],
    [{}, false],
    ["", false],
    [" 5000 ", false],
    ["1", true],
  ] as const) {
    const t = await createTelemetryWith(
      { ...OPTIONS, hermetic: true, spanExporter: slowSpanExporter(60) },
      rig().platform,
    );
    t.tracerProvider.getTracer("t").startSpan("s").end();
    const report = await t.shutdown({ timeoutMillis: given as never });
    assert.equal(report.ok, !expires, `timeoutMillis ${JSON.stringify(given)}: ${JSON.stringify(report)}`);
  }
});

// Third review: instrument calls and wide records never throw into the application, and what they
// drop is written by the handle's own handler, without the message of what was thrown.
test("instruments and wide records on a handle never throw, and report on its diagnostic stream", async () => {
  const marker = "tok_MARKER_handle";
  const { platform } = rig();
  const t = await createTelemetryWith(OPTIONS, platform);
  try {
    const meter = t.meterProvider.getMeter("app");
    const attrs = {
      route: "/a",
      get bad(): string {
        throw new RangeError(`no row for ${marker}`);
      },
    };
    assert.doesNotThrow(() => meter.createCounter("app.jobs").add(1, attrs));
    assert.doesNotThrow(() => meter.createHistogram("app.latency").record(0.2, revokedProxy()));
    const { record } = startRecord(ROOT_CONTEXT);
    assert.doesNotThrow(() => record.emitEvent(t, "o11y.custom", attrs));
    const errors = errorLines(platform);
    assert.deepEqual(
      errors.map((l) => l.replace(/^time=\S+ level=WARN msg="o11y: telemetry error" error=/, "")),
      [
        '"o11y: metric attribute \\"bad\\" cannot be read and is dropped: RangeError"',
        '"o11y: metric attributes cannot be read and are dropped: TypeError"',
        '"o11y: wide record attribute \\"bad\\" cannot be read and is dropped: RangeError"',
      ],
    );
    assert.ok(!platform.diagnostics.join("\n").includes("MARKER"));
    const event = lineObjects(platform.lines as string[]).find((l) => l.msg === "o11y.custom");
    assert.equal(event?.route, "/a", "the event went out with what could be read");
  } finally {
    await t.shutdown();
  }
});
