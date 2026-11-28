/**
 * The consent boundary in the metric exporter, over a real MeterProvider and a delivery that keeps
 * every body. The end-to-end revocation tests are in ../revocation.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordingGate } from "@libo11y/core";
import {
  AggregationTemporality,
  AggregationType,
  MeterProvider,
  MetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import type { OtlpBatch } from "../contracts/otlp.ts";
import type { Delivery } from "../contracts/transport.ts";
import { createMetricExporter } from "./exporters.ts";

interface Gate extends RecordingGate {
  open: boolean;
}

function gate(): Gate {
  const g = {
    open: true,
    recording: () => g.open,
    subscribe: () => () => {},
  };
  return g;
}

function capture(): Delivery & { readonly batches: OtlpBatch[] } {
  const batches: OtlpBatch[] = [];
  return {
    batches,
    async deliver(batch) {
      batches.push(batch);
      return { outcome: "sent" };
    },
    drain: async () => {},
    clear: async () => {},
    shutdown: async () => ({ timedOut: [] }),
  };
}

// A reader whose collect() the test exports by hand through exporter.
class ManualReader extends MetricReader {
  private readonly exporter: PushMetricExporter;
  constructor(exporter: PushMetricExporter) {
    super({
      aggregationTemporalitySelector: (t) =>
        exporter.selectAggregationTemporality?.(t) ?? AggregationTemporality.CUMULATIVE,
      ...(exporter.selectAggregation === undefined
        ? {}
        : { aggregationSelector: exporter.selectAggregation }),
    });
    this.exporter = exporter;
  }
  async exportOnce(): Promise<void> {
    const { resourceMetrics } = await this.collect();
    await new Promise<void>((resolve) => this.exporter.export(resourceMetrics, () => resolve()));
  }
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

type Json = Record<string, unknown>;

function lastPoints(d: { batches: OtlpBatch[] }, name: string): Json[] {
  const last = d.batches.at(-1);
  if (last === undefined) return [];
  const body = JSON.parse(last.body) as Json;
  return (body.resourceMetrics as Json[]).flatMap((rm) =>
    (rm.scopeMetrics as Json[]).flatMap((sm) =>
      (sm.metrics as Json[])
        .filter((m) => m.name === name)
        .flatMap(
          (m) =>
            ((m.sum ?? m.gauge ?? m.histogram ?? m.exponentialHistogram) as { dataPoints: Json[] })
              .dataPoints,
        ),
    ),
  );
}

function setup(
  temporality: "cumulative" | "delta",
  views: ConstructorParameters<typeof MeterProvider>[0] = {},
) {
  const g = gate();
  const delivery = capture();
  const reader = new ManualReader(createMetricExporter(delivery, temporality, g));
  const provider = new MeterProvider({ ...views, readers: [reader] });
  return { g, delivery, reader, meter: provider.getMeter("m") };
}

test("delta temporality is unchanged by a closed-gate export", async () => {
  const { g, delivery, reader, meter } = setup("delta");
  const counter = meter.createCounter("c");
  counter.add(5);
  g.open = false;
  await reader.exportOnce();
  assert.equal(delivery.batches.length, 0, "an export into the closed gate is not delivered");
  g.open = true;
  counter.add(2);
  await reader.exportOnce();
  const [p] = lastPoints(delivery, "c");
  assert.equal(p?.asDouble, 2);
});

test("without a closed-gate export, cumulative points pass through as they are", async () => {
  const { delivery, reader, meter } = setup("cumulative");
  meter.createCounter("c").add(5);
  await reader.exportOnce();
  await reader.exportOnce();
  assert.equal(lastPoints(delivery, "c")[0]?.asDouble, 5);
});

test("a collection with nothing new since the boundary is not delivered", async () => {
  const { g, delivery, reader, meter } = setup("cumulative");
  meter.createCounter("c").add(5);
  g.open = false;
  await reader.exportOnce();
  g.open = true;
  await reader.exportOnce();
  assert.equal(delivery.batches.length, 0);
});

test("observable counters export their change since the boundary, observable gauges a new reading", async () => {
  const { g, delivery, reader, meter } = setup("cumulative");
  let total = 10;
  let reading = 3;
  meter.createObservableCounter("oc").addCallback((r) => r.observe(total));
  meter.createObservableUpDownCounter("ou").addCallback((r) => r.observe(total));
  meter.createObservableGauge("og").addCallback((r) => r.observe(reading));
  g.open = false;
  await reader.exportOnce();
  g.open = true;
  total = 15;
  await reader.exportOnce();
  assert.equal(lastPoints(delivery, "oc")[0]?.asDouble, 5);
  assert.equal(lastPoints(delivery, "ou")[0]?.asDouble, 5);
  assert.deepEqual(lastPoints(delivery, "og"), [], "the same reading as at the boundary is left out");
  reading = 4;
  await reader.exportOnce();
  assert.equal(lastPoints(delivery, "og")[0]?.asDouble, 4);
});

test("an exponential histogram subtracts the boundary's buckets, at the current scale", async () => {
  const { g, delivery, reader, meter } = setup("cumulative", {
    views: [{ instrumentName: "e", aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM } }],
  });
  const h = meter.createHistogram("e");
  h.record(1);
  h.record(2);
  g.open = false;
  await reader.exportOnce();
  g.open = true;
  // A wide range lowers the scale, so the boundary's buckets must be merged to compare.
  h.record(1_000_000);
  await reader.exportOnce();
  const [p] = lastPoints(delivery, "e");
  assert.equal(Number(p?.count), 1);
  assert.equal(p?.sum, 1_000_000);
  assert.equal(p?.min, undefined);
  assert.equal(p?.max, undefined);
  const positive = p?.positive as { bucketCounts: unknown[] };
  assert.equal(
    positive.bucketCounts.map(Number).reduce((a, b) => a + b, 0),
    1,
  );
});
