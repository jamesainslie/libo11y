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
    dropped.map((d) => d["o11y.signal"]),
    ["logs"],
  );
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
