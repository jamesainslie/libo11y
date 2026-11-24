/**
 * The exporters built from OTEL_*: the route table, and end to end against the @libo11y/test sink on
 * both runtimes for every signal over http/protobuf and http/json, plus the console and none routes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTelemetryWith,
  ExemplarStore,
  O11yError,
  type ResolvedConfig,
  type Telemetry,
} from "@libo11y/core";
import { type OtlpSink, startOtlpSink } from "@libo11y/test";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { OTLPExporterBase } from "@opentelemetry/otlp-exporter-base";
import { ConsoleLogRecordExporter } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { AlwaysOnSampler, ConsoleSpanExporter, ParentBasedSampler } from "@opentelemetry/sdk-trace";
import { buildExporters } from "./exporters.ts";
import { serverPlatform } from "./platform.ts";
import { clearedOtelEnv, withEnv } from "./test-support/env.ts";

const BATCH = {
  scheduledDelayMillis: 5000,
  exportTimeoutMillis: 5000,
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
};

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    hermetic: false,
    sdkDisabled: false,
    traces: "otlp",
    metrics: "otlp",
    logs: "otlp",
    protocol: { traces: "http/protobuf", metrics: "http/protobuf", logs: "http/protobuf" },
    endpoints: {
      endpoint: undefined,
      traces_endpoint: undefined,
      metrics_endpoint: undefined,
      logs_endpoint: undefined,
    },
    sampler: {
      name: "parentbased_always_on",
      instance: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    },
    exemplarFilter: "trace_based",
    logLevel: "info",
    console: "off",
    batch: { spans: BATCH, logs: BATCH },
    metricExport: { intervalMillis: 60000, timeoutMillis: 5000 },
    runtimeMetrics: false,
    startupSummary: false,
    ...overrides,
  };
}

const exemplars = (): ExemplarStore => new ExemplarStore({ filter: "trace_based" });

async function shutdownAll(set: ReturnType<typeof buildExporters>): Promise<void> {
  await Promise.all([
    set.spanExporter?.shutdown(),
    set.metricReader?.shutdown(),
    set.logExporter?.shutdown(),
  ]);
}

test("otlp builds upstream OTLP exporters and a periodic metric reader", async () => {
  const set = buildExporters({ config: config(), exemplars: exemplars() });
  try {
    assert.ok(set.spanExporter instanceof OTLPExporterBase);
    assert.ok(set.logExporter instanceof OTLPExporterBase);
    assert.ok(set.metricReader instanceof PeriodicExportingMetricReader);
  } finally {
    await shutdownAll(set);
  }
});

test("console builds the upstream console exporters", async () => {
  const set = buildExporters({
    config: config({ traces: "console", metrics: "console", logs: "console" }),
    exemplars: exemplars(),
  });
  try {
    assert.ok(set.spanExporter instanceof ConsoleSpanExporter);
    assert.ok(set.logExporter instanceof ConsoleLogRecordExporter);
    assert.ok(set.metricReader instanceof PeriodicExportingMetricReader);
  } finally {
    await shutdownAll(set);
  }
});

test("none and injected build nothing", () => {
  for (const route of ["none", "injected"] as const) {
    const set = buildExporters({
      config: config({ traces: route, metrics: route, logs: route }),
      exemplars: exemplars(),
    });
    assert.deepEqual(set, {}, route);
  }
});

test("a metric export timeout above the interval is clamped to it, as sdk-node does", async () => {
  const set = buildExporters({
    config: config({
      traces: "none",
      logs: "none",
      metricExport: { intervalMillis: 100, timeoutMillis: 5000 },
    }),
    exemplars: exemplars(),
  });
  try {
    assert.ok(set.metricReader instanceof PeriodicExportingMetricReader);
  } finally {
    await shutdownAll(set);
  }
});

const OPTIONS = {
  serviceName: "exporters-test",
  environment: "test",
  runtimeMetrics: false,
  console: false,
} as const;

// emit records a span, a log correlated to it through the explicit context, and a histogram value
// in the span's context, so the metric carries an exemplar.
function emit(telemetry: Telemetry): { traceId: string } {
  const span = telemetry.tracerProvider.getTracer("app").startSpan("GET /items");
  const ctx = trace.setSpan(ROOT_CONTEXT, span);
  telemetry.event("app.item.listed", { "app.count": 3 }, ctx);
  telemetry.meterProvider.getMeter("app").createHistogram("app.latency", { unit: "s" }).record(0.25, {}, ctx);
  telemetry.meterProvider.getMeter("app").createCounter("app.jobs").add(1);
  span.end();
  return { traceId: span.spanContext().traceId };
}

async function telemetryFor(env: Record<string, string | undefined>): Promise<Telemetry> {
  return withEnv({ ...clearedOtelEnv(), ...env }, () => createTelemetryWith(OPTIONS, serverPlatform()));
}

async function withSink(fn: (sink: OtlpSink) => Promise<void>): Promise<void> {
  const sink = await startOtlpSink();
  try {
    await fn(sink);
  } finally {
    await sink.close();
  }
}

type Json = Record<string, unknown>;

function allMetrics(sink: OtlpSink): Json[] {
  return (sink.metrics() as Json[]).flatMap((req) =>
    (req.resourceMetrics as Json[]).flatMap((rm) =>
      (rm.scopeMetrics as Json[]).flatMap((sm) => sm.metrics as Json[]),
    ),
  );
}

function metricNamed(sink: OtlpSink, name: string): Json {
  const m = allMetrics(sink).find((x) => x.name === name);
  assert.ok(m !== undefined, `metric ${name} reached the sink`);
  return m;
}

// first follows the first element of each named list, as in resourceLogs[0].scopeLogs[0].logRecords[0].
function first(value: unknown, ...lists: string[]): Json | undefined {
  let at = value as Json | undefined;
  for (const key of lists) at = (at?.[key] as Json[] | undefined)?.[0];
  return at;
}

function firstLog(sink: OtlpSink): Json {
  const record = first(sink.logs()[0], "resourceLogs", "scopeLogs", "logRecords");
  assert.ok(record !== undefined, "a log record reached the sink");
  return record;
}

function firstSpan(sink: OtlpSink): Json {
  const span = first(sink.traces()[0], "resourceSpans", "scopeSpans", "spans");
  assert.ok(span !== undefined, "a span reached the sink");
  return span;
}

for (const [protocol, contentType] of [
  ["http/protobuf", "application/x-protobuf"],
  ["http/json", "application/json"],
] as const) {
  test(`traces, metrics with exemplars and logs reach the sink over ${protocol}`, async () => {
    await withSink(async (sink) => {
      const telemetry = await telemetryFor({
        OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
        OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
      });
      const { traceId } = emit(telemetry);
      const report = await telemetry.shutdown();
      assert.deepEqual(report.errors, []);

      for (const path of ["/v1/traces", "/v1/metrics", "/v1/logs"]) {
        const req = sink.requests().find((r) => r.path === path);
        assert.equal(req?.contentType, contentType, path);
      }
      assert.equal(firstSpan(sink).traceId, traceId);
      const log = firstLog(sink);
      assert.equal(log.traceId, traceId);
      assert.deepEqual((log.attributes as Json[])[0], {
        key: "event.name",
        value: { stringValue: "app.item.listed" },
      });
      const latency = metricNamed(sink, "app.latency").histogram as { dataPoints: Json[] };
      const [exemplar] = (latency.dataPoints[0]?.exemplars ?? []) as Json[];
      assert.equal(exemplar?.traceId, traceId, "the exemplar survived the wire");
      assert.equal(exemplar?.asDouble, 0.25);
      // Upstream's default temporality preference is cumulative.
      assert.equal((metricNamed(sink, "app.jobs").sum as Json).aggregationTemporality, 2);
    });
  });
}

test("the per-signal protocol variables override OTEL_EXPORTER_OTLP_PROTOCOL", async () => {
  await withSink(async (sink) => {
    const telemetry = await telemetryFor({
      OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf",
    });
    emit(telemetry);
    await telemetry.shutdown();
    const types = Object.fromEntries(sink.requests().map((r) => [r.path, r.contentType]));
    assert.deepEqual(types, {
      "/v1/traces": "application/json",
      "/v1/metrics": "application/x-protobuf",
      "/v1/logs": "application/x-protobuf",
    });
  });
});

test("per-signal endpoints, compression and temporality come from upstream's own variables", async () => {
  await withSink(async (sink) => {
    await withSink(async (metricsSink) => {
      const telemetry = await telemetryFor({
        OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${metricsSink.url}/v1/metrics`,
        OTEL_EXPORTER_OTLP_METRICS_COMPRESSION: "gzip",
        OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta",
      });
      emit(telemetry);
      await telemetry.shutdown();
      assert.equal(sink.metrics().length, 0, "metrics went to their own endpoint");
      assert.equal(sink.traces().length, 1);
      const [req] = metricsSink.requests();
      assert.equal(req?.encoding, "gzip");
      assert.equal((metricNamed(metricsSink, "app.jobs").sum as Json).aggregationTemporality, 1);
      const latency = metricNamed(metricsSink, "app.latency").histogram as { dataPoints: Json[] };
      assert.equal(((latency.dataPoints[0]?.exemplars ?? []) as Json[]).length, 1);
    });
  });
});

test("OTEL_METRIC_EXPORT_INTERVAL drives the periodic reader", async () => {
  await withSink(async (sink) => {
    const telemetry = await telemetryFor({
      OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
      OTEL_METRIC_EXPORT_INTERVAL: "100",
      OTEL_TRACES_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
    });
    try {
      telemetry.meterProvider.getMeter("app").createCounter("app.jobs").add(1);
      await sink.waitFor("metrics", 2, 5000);
    } finally {
      await telemetry.shutdown();
    }
    assert.ok(metricNamed(sink, "app.jobs"));
  });
});

test("OTEL_*_EXPORTER=none sends nothing for that signal", async () => {
  await withSink(async (sink) => {
    const telemetry = await telemetryFor({
      OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
      OTEL_TRACES_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
    });
    emit(telemetry);
    await telemetry.shutdown();
    assert.deepEqual([...new Set(sink.requests().map((r) => r.path))], ["/v1/metrics"]);
  });
});

test("OTEL_*_EXPORTER=console writes every signal through the console, metrics with exemplars", async () => {
  const lines: unknown[] = [];
  const original = { dir: console.dir, log: console.log };
  const telemetry = await telemetryFor({
    OTEL_TRACES_EXPORTER: "console",
    OTEL_METRICS_EXPORTER: "console",
    OTEL_LOGS_EXPORTER: "console",
  });
  console.dir = (value: unknown) => {
    lines.push(value);
  };
  console.log = (...values: unknown[]) => {
    lines.push(values);
  };
  try {
    const { traceId } = emit(telemetry);
    await telemetry.shutdown();
    const text = JSON.stringify(lines, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    assert.ok(text.includes("GET /items"), "the span was written");
    assert.ok(text.includes("app.item.listed"), "the log was written");
    assert.ok(text.includes("app.latency"), "the metric was written");
    assert.ok(text.includes(`"exemplars"`) && text.includes(traceId), "the metric carries its exemplar");
  } finally {
    console.dir = original.dir;
    console.log = original.log;
  }
});

test("grpc is refused with UNSUPPORTED_PROTOCOL", async () => {
  await assert.rejects(
    telemetryFor({ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }),
    (err: unknown) => err instanceof O11yError && err.code === "UNSUPPORTED_PROTOCOL",
  );
});
