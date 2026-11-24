import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { startRuntimeMetrics } from "./runtime-metrics.ts";

const IS_BUN = "Bun" in globalThis;
const UTILIZATION = "nodejs.eventloop.utilization";

class ManualReader extends MetricReader {
  protected override async onShutdown(): Promise<void> {}

  protected override async onForceFlush(): Promise<void> {}
}

function names(rm: ResourceMetrics): string[] {
  return rm.scopeMetrics.flatMap((sm) =>
    sm.metrics.filter((m) => m.dataPoints.length > 0).map((m) => m.descriptor.name),
  );
}

async function rig(
  fn: (reader: ManualReader, provider: MeterProvider) => Promise<void>,
  delta = false,
): Promise<void> {
  const reader = new ManualReader(
    delta ? { aggregationTemporalitySelector: () => AggregationTemporality.DELTA } : {},
  );
  const provider = new MeterProvider({ readers: [reader] });
  try {
    await fn(reader, provider);
  } finally {
    await provider.shutdown();
  }
}

test("runtime metrics report the event loop on the meter provider they are given", async () => {
  await rig(async (reader, provider) => {
    const running = startRuntimeMetrics(provider);
    try {
      // The delay histogram reports once it holds five samples at 10 ms resolution.
      let got = names((await reader.collect()).resourceMetrics);
      for (let i = 0; i < 100 && !got.includes("nodejs.eventloop.delay.p99"); i++) {
        await new Promise((r) => setTimeout(r, 20));
        got = names((await reader.collect()).resourceMetrics);
      }
      for (const name of ["nodejs.eventloop.delay.p99", "nodejs.eventloop.time"]) {
        assert.ok(got.includes(name), `${name} in ${got.join(", ")}`);
      }
      // Bun reports zero event loop utilization (oven-sh/bun#34068), so libo11y does not record it there.
      assert.equal(got.includes(UTILIZATION), !IS_BUN);
      if (!IS_BUN) assert.ok(got.includes("v8js.memory.heap.used"), "Node reports the V8 heap");
    } finally {
      running.stop();
    }
  });
});

test("the Bun filter turns nodejs.eventloop.utilization into a no-op and keeps the rest", async () => {
  await rig(async (reader, provider) => {
    const running = startRuntimeMetrics(provider, { dropEventLoopUtilization: true });
    try {
      const got = names((await reader.collect()).resourceMetrics);
      assert.equal(got.includes(UTILIZATION), false);
      assert.ok(got.includes("nodejs.eventloop.time"), got.join(", "));
    } finally {
      running.stop();
    }
  });
});

test("without the filter nodejs.eventloop.utilization is recorded, on either runtime", async () => {
  await rig(async (reader, provider) => {
    const running = startRuntimeMetrics(provider, { dropEventLoopUtilization: false });
    try {
      assert.ok(names((await reader.collect()).resourceMetrics).includes(UTILIZATION));
    } finally {
      running.stop();
    }
  });
});

test("stop disables the instrumentation: no further observations", async () => {
  await rig(async (reader, provider) => {
    const running = startRuntimeMetrics(provider);
    assert.ok(names((await reader.collect()).resourceMetrics).length > 0);
    running.stop();
    assert.deepEqual(names((await reader.collect()).resourceMetrics), []);
  }, true);
});
