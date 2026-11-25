/** OTLP JSON of real SDK spans, log records and metrics. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type DataPointWithExemplars, type Exemplar, OtlpJsonMetricsSerializer } from "@libo11y/core";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { MeterProvider, MetricReader, type ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { serializeLogs, serializeMetrics, serializeSpans } from "./serialize.ts";

const resource = resourceFromAttributes({ "service.name": "shop", "browser.platform": "Linux" });

interface KeyValue {
  key: string;
  value: { stringValue?: string };
}

function attr(list: readonly KeyValue[] | undefined, key: string): string | undefined {
  return list?.find((kv) => kv.key === key)?.value.stringValue;
}

test("spans serialize to OTLP JSON with hex ids and the resource", async () => {
  const exporter = new InMemorySpanExporter();
  const tp = new TracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const parent = tp
    .getTracer("app", "1.2.3")
    .startSpan("GET /cart", { attributes: { "http.method": "GET" } });
  const child = tp.getTracer("app").startSpan("child", {}, trace.setSpan(ROOT_CONTEXT, parent));
  child.end();
  parent.end();
  await tp.forceFlush();
  const spans = exporter.getFinishedSpans();
  const body = serializeSpans(spans);
  assert.equal(typeof body, "string");
  const json = JSON.parse(body) as {
    resourceSpans: {
      resource: { attributes: KeyValue[] };
      scopeSpans: {
        scope: { name: string; version?: string };
        spans: {
          traceId: string;
          spanId: string;
          parentSpanId?: string;
          name: string;
          attributes: KeyValue[];
        }[];
      }[];
    }[];
  };
  const rs = json.resourceSpans[0];
  assert.equal(attr(rs?.resource.attributes, "service.name"), "shop");
  const all = rs?.scopeSpans.flatMap((s) => s.spans) ?? [];
  assert.equal(all.length, 2);
  const p = all.find((s) => s.name === "GET /cart");
  const c = all.find((s) => s.name === "child");
  assert.equal(p?.traceId, parent.spanContext().traceId);
  assert.match(p?.traceId ?? "", /^[0-9a-f]{32}$/);
  assert.equal(p?.spanId, parent.spanContext().spanId);
  assert.match(p?.spanId ?? "", /^[0-9a-f]{16}$/);
  assert.equal(c?.parentSpanId, parent.spanContext().spanId);
  assert.equal(attr(p?.attributes, "http.method"), "GET");
  await tp.shutdown();
});

test("an empty span list still serializes", () => {
  assert.deepEqual(JSON.parse(serializeSpans([])), { resourceSpans: [] });
});

test("log records serialize to OTLP JSON with the resource and the trace correlation", async () => {
  const exporter = new InMemoryLogRecordExporter();
  const lp = new LoggerProvider({ resource, processors: [new SimpleLogRecordProcessor({ exporter })] });
  const tp = new TracerProvider();
  const span = tp.getTracer("t").startSpan("s");
  lp.getLogger("app").emit({
    body: "hello",
    severityText: "INFO",
    attributes: { "app.k": "v" },
    context: trace.setSpan(ROOT_CONTEXT, span),
  });
  span.end();
  await lp.forceFlush();
  const body = serializeLogs(exporter.getFinishedLogRecords());
  const json = JSON.parse(body) as {
    resourceLogs: {
      resource: { attributes: KeyValue[] };
      scopeLogs: { logRecords: { body: { stringValue: string }; traceId?: string; spanId?: string }[] }[];
    }[];
  };
  const rl = json.resourceLogs[0];
  assert.equal(attr(rl?.resource.attributes, "service.name"), "shop");
  const rec = rl?.scopeLogs[0]?.logRecords[0];
  assert.equal(rec?.body.stringValue, "hello");
  assert.equal(rec?.traceId, span.spanContext().traceId);
  assert.equal(rec?.spanId, span.spanContext().spanId);
  await lp.shutdown();
  await tp.shutdown();
});

class TestReader extends MetricReader {
  protected override async onShutdown(): Promise<void> {}
  protected override async onForceFlush(): Promise<void> {}
}

test("metrics with exemplars equal core's OtlpJsonMetricsSerializer output", async () => {
  const reader = new TestReader();
  const mp = new MeterProvider({ resource, readers: [reader] });
  const meter = mp.getMeter("app");
  meter.createHistogram("app.latency", { unit: "s" }).record(0.25, { route: "/cart" });
  meter.createCounter("app.jobs").add(2);
  const { resourceMetrics } = await reader.collect();
  await mp.shutdown();
  // Attach one exemplar to the histogram point as ExemplarStore.attach would.
  const exemplar: Exemplar = {
    timeUnixNano: 1_700_000_000_000_000_000n,
    value: 0.25,
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    filteredAttributes: { "user.tier": "gold" },
  };
  const withExemplars: ResourceMetrics = {
    ...resourceMetrics,
    scopeMetrics: resourceMetrics.scopeMetrics.map((sm) => ({
      ...sm,
      metrics: sm.metrics.map((m) =>
        m.descriptor.name === "app.latency"
          ? ({
              ...m,
              dataPoints: m.dataPoints.map(
                (p) => ({ ...p, exemplars: [exemplar] }) as DataPointWithExemplars<unknown>,
              ),
            } as typeof m)
          : m,
      ),
    })),
  };
  const body = serializeMetrics(withExemplars);
  const expected = JSON.parse(
    new TextDecoder().decode(OtlpJsonMetricsSerializer.serializeRequest(withExemplars)),
  );
  assert.deepEqual(JSON.parse(body), expected);
  assert.match(body, /"exemplars":\[/);
  assert.match(body, /0af7651916cd43dd8448eb211c80319c/);
});
