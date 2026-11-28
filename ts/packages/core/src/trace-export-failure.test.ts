/**
 * A trace export that fails reaches the forceFlush and shutdown reports, in each way an exporter
 * can fail: a FAILED result, a synchronous throw, and a serialization error from span data that
 * cannot be encoded (NaN times, as under React Native's jest preset with no performance.timeOrigin).
 * Shutdown also says the traces were dropped, as it does for logs and metrics.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";
import type { TelemetryOptions } from "./options.ts";
import { createTelemetryWith, type SignalReport, type Telemetry } from "./telemetry.ts";
import { createTestPlatform } from "./testing.ts";

const OPTIONS: TelemetryOptions = {
  serviceName: "svc",
  serviceVersion: "1.2.3",
  environment: "test",
};

type Export = (spans: ReadableSpan[], cb: (result: ExportResult) => void) => void;

const MODES: Record<string, Export> = {
  "reports FAILED": (_spans, cb) => cb({ code: ExportResultCode.FAILED, error: new Error("Not Found") }),
  throws: () => {
    throw new Error("Not Found");
  },
  "fails to serialize, synchronously": (spans, cb) => {
    JsonTraceSerializer.serializeRequest(spans);
    cb({ code: ExportResultCode.SUCCESS });
  },
  "fails to serialize, asynchronously": (spans, cb) => {
    void (async () => {
      try {
        await Promise.resolve();
        JsonTraceSerializer.serializeRequest(spans);
        cb({ code: ExportResultCode.SUCCESS });
      } catch (err) {
        cb({ code: ExportResultCode.FAILED, error: err as Error });
      }
    })();
  },
};

async function telemetryWith(exp: Export): Promise<{ t: Telemetry; lines: string[] }> {
  const lines: string[] = [];
  const platform = createTestPlatform({
    contextManager: () => new AsyncLocalStorageContextManager(),
    writeConsoleLine: (line: string) => {
      lines.push(line);
    },
  });
  const exporter: SpanExporter = { export: exp, shutdown: async () => {} };
  const t = await createTelemetryWith({ ...OPTIONS, spanExporter: exporter }, platform);
  return { t, lines };
}

/** A span whose times cannot be encoded, for the serialization modes. */
function badSpan(t: Telemetry): void {
  t.tracerProvider.getTracer("t").startSpan("s", { startTime: Number.NaN }).end(Number.NaN);
}

function failures(report: SignalReport): string[] {
  return report.errors.map((e) => e.signal);
}

function droppedSignals(lines: readonly string[]): unknown[] {
  return lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.msg === "o11y.telemetry.dropped")
    .map((l) => l["o11y.signal"]);
}

for (const [mode, exp] of Object.entries(MODES)) {
  test(`forceFlush reports traces when the span exporter ${mode}`, async () => {
    const { t } = await telemetryWith(exp);
    try {
      badSpan(t);
      const report = await t.forceFlush();
      assert.equal(report.ok, false);
      assert.deepEqual(failures(report), ["traces"]);
    } finally {
      await t.shutdown();
    }
  });

  test(`shutdown reports traces and says they were dropped when the span exporter ${mode}`, async () => {
    const { t, lines } = await telemetryWith(exp);
    badSpan(t);
    const report = await t.shutdown();
    assert.equal(report.ok, false);
    assert.deepEqual(failures(report), ["traces"]);
    assert.deepEqual(droppedSignals(lines), ["traces"]);
  });
}
