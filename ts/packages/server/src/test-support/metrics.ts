/**
 * A hermetic telemetry whose metrics a test collects on demand, with exemplars attached. Unlike
 * @libo11y/test's recorder it installs no global context manager, so it cannot change what another
 * test file sees when Bun runs every file in one process; pass contexts explicitly instead.
 */
import {
  createTelemetryWith,
  type ResourceMetricsWithExemplars,
  type Telemetry,
  type TelemetryOptions,
} from "@libo11y/core";
import { createTestPlatform, exemplarStoreOf } from "@libo11y/core/testing";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { MetricReader } from "@opentelemetry/sdk-metrics";
import { AlwaysOnSampler } from "@opentelemetry/sdk-trace";

class ManualReader extends MetricReader {
  protected override async onShutdown(): Promise<void> {}

  protected override async onForceFlush(): Promise<void> {}
}

/** A telemetry with a manual metric reader. */
export interface MetricsRig {
  readonly telemetry: Telemetry;
  /** Collects every instrument, with the exemplars the store sampled attached. */
  collect(): Promise<ResourceMetricsWithExemplars>;
  shutdown(): Promise<void>;
}

export async function metricsRig(options: TelemetryOptions = {}): Promise<MetricsRig> {
  const reader = new ManualReader();
  const telemetry = await createTelemetryWith(
    {
      serviceName: "server-test",
      environment: "test",
      console: false,
      runtimeMetrics: false,
      startupSummary: false,
      sampler: new AlwaysOnSampler(),
      ...options,
      hermetic: true,
      metricReader: reader,
    },
    createTestPlatform({ contextManager: () => new AsyncLocalStorageContextManager() }),
  );
  return {
    telemetry,
    collect: async () => exemplarStoreOf(telemetry).attach((await reader.collect()).resourceMetrics),
    shutdown: async () => {
      await telemetry.shutdown();
    },
  };
}
