// OTEL_SDK_DISABLED as Go treats it: the no-op tracer provider, the injected parts stopped, and a
// warning for a value that is neither true nor false. Also what a failed setup leaves behind:
// nothing flushed, nothing said dropped, and every injected part stopped once.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  isSpanContextValid,
  ROOT_CONTEXT,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { LogRecordExporter, LogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { type SpanExporter, type SpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { O11yError } from "./errors.ts";
import type { TelemetryOptions } from "./options.ts";
import type { Platform } from "./platform.ts";
import { createTelemetryWith, setupWith } from "./telemetry.ts";
import { createTestPlatform, type TestPlatform } from "./testing.ts";

const OPTIONS: TelemetryOptions = { serviceName: "svc", serviceVersion: "1.2.3", environment: "test" };
const GUARD = Symbol.for("libo11y.setup");
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

function platformWith(env: Record<string, string>, overrides: Partial<Platform> = {}): TestPlatform {
  return createTestPlatform({
    contextManager: () => new AsyncLocalStorageContextManager(),
    env: () => env,
    ...overrides,
  });
}

function lineObjects(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

interface Counts {
  exports: number;
  shutdowns: number;
}

// injectedParts returns one of each part an option can inject, each counting its exports and its
// shutdowns. A hung exporter never reports an export's result.
function injectedParts(hung = false) {
  const spanExporterCounts: Counts = { exports: 0, shutdowns: 0 };
  const logExporterCounts: Counts = { exports: 0, shutdowns: 0 };
  const spanProcessorCounts: Counts = { exports: 0, shutdowns: 0 };
  const logProcessorCounts: Counts = { exports: 0, shutdowns: 0 };
  const readerCounts: Counts = { exports: 0, shutdowns: 0 };
  const spanExporter: SpanExporter = {
    export: (_spans, cb) => {
      spanExporterCounts.exports++;
      if (!hung) cb({ code: 0 });
    },
    shutdown: async () => {
      spanExporterCounts.shutdowns++;
    },
  };
  const logExporter: LogRecordExporter = {
    export: (_records, cb) => {
      logExporterCounts.exports++;
      if (!hung) cb({ code: 0 });
    },
    forceFlush: async () => {},
    shutdown: async () => {
      logExporterCounts.shutdowns++;
    },
  };
  const spanProcessor: SpanProcessor = {
    onStart: () => {},
    onEnd: () => {
      spanProcessorCounts.exports++;
    },
    forceFlush: async () => {},
    shutdown: async () => {
      spanProcessorCounts.shutdowns++;
    },
  };
  const logProcessor: LogRecordProcessor = {
    onEmit: () => {
      logProcessorCounts.exports++;
    },
    forceFlush: async () => {},
    shutdown: async () => {
      logProcessorCounts.shutdowns++;
    },
  };
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 3_600_000,
  });
  const shutdown = metricReader.shutdown.bind(metricReader);
  metricReader.shutdown = (opts) => {
    readerCounts.shutdowns++;
    return shutdown(opts);
  };
  return {
    options: { spanExporter, logExporter, spanProcessor, logProcessor, metricReader },
    counts: {
      spanExporter: spanExporterCounts,
      logExporter: logExporterCounts,
      spanProcessor: spanProcessorCounts,
      logProcessor: logProcessorCounts,
      metricReader: readerCounts,
    },
  };
}

function shutdowns(counts: Record<string, Counts>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.shutdowns]));
}

function warnings(platform: TestPlatform): string[] {
  return platform.diagnostics.filter((l) => l.includes("OTEL_SDK_DISABLED"));
}

function droppedLines(platform: TestPlatform): string[] {
  return [...platform.lines, ...platform.diagnostics].filter((l) => l.includes("o11y.telemetry.dropped"));
}

test("OTEL_SDK_DISABLED: the handle's tracer starts non-recording spans that carry a valid parent's span context", async () => {
  const t = await createTelemetryWith(OPTIONS, platformWith({ OTEL_SDK_DISABLED: "true" }));
  try {
    assert.ok(!(t.tracerProvider instanceof TracerProvider), "no SDK tracer provider is handed out");
    const tracer = t.tracerProvider.getTracer("app");
    const inbound = t.propagator.extract(ROOT_CONTEXT, { traceparent: TRACEPARENT }, defaultTextMapGetter);
    const span = tracer.startSpan("GET /items", undefined, inbound);
    assert.equal(span.isRecording(), false);
    assert.equal(span.spanContext().traceId, TRACE_ID);
    assert.equal(span.spanContext().spanId, SPAN_ID);
    span.end();

    // The parent travels on: an outgoing request carries the inbound trace, not a new one.
    const carrier: Record<string, string> = {};
    t.propagator.inject(trace.setSpan(inbound, span), carrier, defaultTextMapSetter);
    assert.equal(carrier.traceparent, TRACEPARENT);

    const root = tracer.startSpan("root");
    assert.equal(root.isRecording(), false);
    assert.equal(isSpanContextValid(root.spanContext()), false, "a root span gets no new IDs");
    root.end();
  } finally {
    await t.shutdown();
  }
});

test("OTEL_SDK_DISABLED: setup installs the no-op tracer provider, and a log keeps the inbound trace ID", async () => {
  const platform = platformWith({ OTEL_SDK_DISABLED: "true" });
  const t = await setupWith(OPTIONS, platform);
  try {
    const inbound = t.propagator.extract(ROOT_CONTEXT, { traceparent: TRACEPARENT }, defaultTextMapGetter);
    const global = trace.getTracer("lib").startSpan("global", undefined, inbound);
    assert.equal(global.isRecording(), false);
    assert.equal(global.spanContext().traceId, TRACE_ID);
    assert.equal(global.spanContext().spanId, SPAN_ID);
    assert.equal(isSpanContextValid(trace.getTracer("lib").startSpan("root").spanContext()), false);

    context.with(inbound, () => {
      t.tracerProvider.getTracer("app").startActiveSpan("GET /items", (span) => {
        t.logger.info("handling");
        span.end();
      });
    });
    const line = lineObjects(platform.lines).find((l) => l.msg === "handling");
    assert.equal(line?.trace_id, TRACE_ID);
    assert.equal(line?.span_id, SPAN_ID);
  } finally {
    await t.shutdown();
  }
});

test("OTEL_SDK_DISABLED: the injected reader stops at once, and the other injected parts once at shutdown", async () => {
  const { options, counts } = injectedParts();
  const t = await createTelemetryWith(
    { ...OPTIONS, ...options },
    platformWith({ OTEL_SDK_DISABLED: "true" }),
  );
  assert.deepEqual(shutdowns(counts), {
    spanExporter: 0,
    logExporter: 0,
    spanProcessor: 0,
    logProcessor: 0,
    metricReader: 1,
  });
  await t.shutdown();
  assert.deepEqual(shutdowns(counts), {
    spanExporter: 1,
    logExporter: 1,
    spanProcessor: 1,
    logProcessor: 1,
    metricReader: 1,
  });
});

test("OTEL_SDK_DISABLED that is neither true nor false warns once, and the SDK stays enabled", async () => {
  const platform = platformWith({ OTEL_SDK_DISABLED: "yes" });
  const t = await createTelemetryWith(OPTIONS, platform);
  try {
    assert.equal(t.tracerProvider.getTracer("app").startSpan("s").isRecording(), true);
    const lines = warnings(platform);
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.ok(
      lines[0]?.includes(
        'msg="o11y: telemetry error" error="o11y: OTEL_SDK_DISABLED=\\"yes\\" is neither true nor false; the SDK stays enabled"',
      ),
      lines[0],
    );
  } finally {
    await t.shutdown();
  }
});

test("OTEL_SDK_DISABLED TRUE, false, empty or unset gives no warning, and hermetic mode ignores it", async () => {
  for (const [env, hermetic] of [
    [{ OTEL_SDK_DISABLED: "TRUE" }, false],
    [{ OTEL_SDK_DISABLED: "false" }, false],
    [{ OTEL_SDK_DISABLED: "" }, false],
    [{}, false],
    [{ OTEL_SDK_DISABLED: "yes" }, true],
  ] as const) {
    const platform = platformWith(env);
    const t = await createTelemetryWith({ ...OPTIONS, hermetic }, platform);
    try {
      assert.deepEqual(warnings(platform), [], JSON.stringify(env));
    } finally {
      await t.shutdown();
    }
  }
  const t = await createTelemetryWith(
    { ...OPTIONS, hermetic: true },
    platformWith({ OTEL_SDK_DISABLED: "true" }),
  );
  try {
    assert.equal(t.tracerProvider.getTracer("app").startSpan("s").isRecording(), true);
  } finally {
    await t.shutdown();
  }
});

test("a build that throws after the options were accepted stops every injected part once", async () => {
  const pii = injectedParts();
  await assert.rejects(
    createTelemetryWith({ ...OPTIONS, ...pii.options, piiMode: "hash" }, platformWith({})),
    (err: unknown) => err instanceof O11yError && err.code === "PII_HASH_KEY",
  );
  assert.deepEqual(shutdowns(pii.counts), {
    spanExporter: 1,
    logExporter: 1,
    spanProcessor: 1,
    logProcessor: 1,
    metricReader: 1,
  });

  const runtime = injectedParts();
  const platform = platformWith(
    {},
    {
      startRuntimeMetrics: () => {
        throw new Error("no runtime here");
      },
    },
  );
  await assert.rejects(createTelemetryWith({ ...OPTIONS, ...runtime.options }, platform), /no runtime here/);
  assert.deepEqual(shutdowns(runtime.counts), {
    spanExporter: 1,
    logExporter: 1,
    spanProcessor: 1,
    logProcessor: 1,
    metricReader: 1,
  });
});

test("ALREADY_SETUP stops what the second call injected, but not what the live telemetry owns", async () => {
  const first = injectedParts();
  const t = await setupWith({ ...OPTIONS, spanExporter: first.options.spanExporter }, platformWith({}));
  try {
    const second = injectedParts();
    await assert.rejects(
      setupWith(
        { ...OPTIONS, ...second.options, spanExporter: first.options.spanExporter },
        platformWith({}),
      ),
      (err: unknown) => err instanceof O11yError && err.code === "ALREADY_SETUP",
    );
    assert.deepEqual(shutdowns(second.counts), {
      spanExporter: 0,
      logExporter: 1,
      spanProcessor: 1,
      logProcessor: 1,
      metricReader: 1,
    });
    assert.equal(first.counts.spanExporter.shutdowns, 0, "the live telemetry's exporter keeps running");
  } finally {
    await t.shutdown();
  }
  assert.equal(first.counts.spanExporter.shutdowns, 1);
});

test("a rejected canary abandons the pipeline: nothing exported, prompt with a hung exporter, no dropped event", async () => {
  const { options, counts } = injectedParts(true);
  const platform = platformWith({});
  const writeConsoleLine = platform.writeConsoleLine.bind(platform);
  platform.writeConsoleLine = (line) => {
    if (line.includes("o11y.telemetry.configured")) throw new Error("stdout closed");
    writeConsoleLine(line);
  };
  const started = Date.now();
  await assert.rejects(
    setupWith({ ...OPTIONS, spanExporter: options.spanExporter, logExporter: options.logExporter }, platform),
    (err: unknown) => err instanceof O11yError && err.code === "CANARY_REJECTED",
  );
  assert.ok(Date.now() - started < 1000, `setup took ${Date.now() - started} ms`);
  assert.equal(counts.logExporter.exports, 0, "the canary's OTLP leg was not sent");
  assert.equal(counts.spanExporter.exports, 0);
  assert.equal(counts.logExporter.shutdowns, 1);
  assert.equal(counts.spanExporter.shutdowns, 1);
  assert.deepEqual(droppedLines(platform), []);
  assert.notEqual((globalThis as Record<symbol, unknown>)[GUARD], true);
  const again = await setupWith(OPTIONS, platformWith({}));
  await again.shutdown();
});

test("a throwing global install abandons the pipeline: nothing exported, prompt with a hung exporter, no dropped event", async () => {
  const { options, counts } = injectedParts(true);
  const broken = {
    enable: () => {
      throw new Error("no async context here");
    },
  } as unknown as ReturnType<Platform["contextManager"]>;
  const platform = platformWith({}, { contextManager: () => broken });
  const started = Date.now();
  await assert.rejects(
    setupWith({ ...OPTIONS, spanExporter: options.spanExporter, logExporter: options.logExporter }, platform),
    /no async context here/,
  );
  assert.ok(Date.now() - started < 1000, `setup took ${Date.now() - started} ms`);
  assert.equal(counts.logExporter.exports, 0, "the canary's OTLP leg was not sent");
  assert.equal(counts.spanExporter.exports, 0);
  assert.equal(counts.logExporter.shutdowns, 1);
  assert.equal(counts.spanExporter.shutdowns, 1);
  assert.deepEqual(droppedLines(platform), []);
  assert.notEqual((globalThis as Record<symbol, unknown>)[GUARD], true);
  assert.equal(
    trace.setGlobalTracerProvider(new TracerProvider()),
    true,
    "no tracer provider stayed installed",
  );
  trace.disable();
  const again = await setupWith(OPTIONS, platformWith({}));
  await again.shutdown();
});
