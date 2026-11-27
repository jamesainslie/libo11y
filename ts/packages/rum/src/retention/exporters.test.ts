import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExporterSet } from "@libo11y/core";
import { EVENT_RUM_VIEW_SUMMARY } from "@libo11y/spec";
import type { OtlpBatch } from "@libo11y/web/internal";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import type { SessionDecision } from "../contracts/session.ts";
import { retainingLogExporter, retainingSpanExporter, withRetention } from "./exporters.ts";

function routing(decisions: Record<string, SessionDecision>, current: SessionDecision) {
  const buffered: OtlpBatch[] = [];
  return {
    buffered,
    decide: (id: string | undefined) => (id === undefined ? current : (decisions[id] ?? "drop")),
    buffer: (b: OtlpBatch) => void buffered.push(b),
  };
}

test("spans are sent, buffered or dropped by their session", async () => {
  const inner = new InMemorySpanExporter();
  const r = routing({ kept: "send", now: "buffer", old: "drop" }, "buffer");
  const tp = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: retainingSpanExporter(inner, r) })],
  });
  const tracer = tp.getTracer("t");
  for (const id of ["kept", "now", "old"]) tracer.startSpan(id, { attributes: { "session.id": id } }).end();
  tracer.startSpan("none").end();
  await tp.forceFlush();
  assert.deepEqual(
    inner.getFinishedSpans().map((s) => s.name),
    ["kept"],
  );
  assert.deepEqual(
    r.buffered.map((b) => b.signal),
    ["traces", "traces"],
  );
  const bodies = r.buffered.map(
    (b) => JSON.parse(b.body) as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] },
  );
  assert.deepEqual(
    bodies.map((b) => b.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.name),
    ["now", "none"],
  );
  await tp.shutdown();
});

test("view summaries always send; other records follow their session", async () => {
  const inner = new InMemoryLogRecordExporter();
  const r = routing({ now: "buffer" }, "buffer");
  const lp = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: retainingLogExporter(inner, r) })],
  });
  const logger = lp.getLogger("t");
  logger.emit({ body: "", attributes: { "event.name": EVENT_RUM_VIEW_SUMMARY, "session.id": "now" } });
  logger.emit({ body: "", attributes: { "event.name": "o11y.rum.error", "session.id": "now" } });
  logger.emit({ body: "app log" });
  await lp.forceFlush();
  assert.deepEqual(
    inner.getFinishedLogRecords().map((l) => l.attributes["event.name"]),
    [EVENT_RUM_VIEW_SUMMARY],
  );
  assert.equal(r.buffered.length, 2);
  assert.ok(r.buffered.every((b) => b.signal === "logs"));
  await lp.shutdown();
});

test("withRetention wraps traces and logs and leaves the metric reader alone", () => {
  const reader = {} as NonNullable<ExporterSet["metricReader"]>;
  const spans = new InMemorySpanExporter();
  const set = withRetention({ spanExporter: spans, metricReader: reader }, routing({}, "send"));
  assert.equal(set.metricReader, reader);
  assert.notEqual(set.spanExporter, spans);
  assert.equal(set.logExporter, undefined);
});
