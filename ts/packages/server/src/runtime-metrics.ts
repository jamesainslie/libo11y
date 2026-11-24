/**
 * Runtime metrics through upstream's RuntimeNodeInstrumentation, on the meter provider core hands
 * over rather than the global one. Bun always reports zero event loop utilization
 * (oven-sh/bun#34068), so on Bun the instrumentation sees a meter provider whose
 * nodejs.eventloop.utilization instrument is a no-op. Bun also has no
 * v8.getHeapSpaceStatistics, so the v8js.memory.heap.* instruments report nothing there.
 */
import type { RuntimeMetrics } from "@libo11y/core";
import {
  type BatchObservableCallback,
  type Counter,
  createNoopMeter,
  type Gauge,
  type Histogram,
  type Meter,
  type MeterOptions,
  type MeterProvider,
  type MetricOptions,
  type Observable,
  type ObservableCounter,
  type ObservableGauge,
  type ObservableUpDownCounter,
  type UpDownCounter,
} from "@opentelemetry/api";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";

/** The instrument Bun cannot report. */
export const EVENT_LOOP_UTILIZATION = "nodejs.eventloop.utilization";

const NOOP: Meter = createNoopMeter();

/** A meter whose instruments named in dropped are no-ops. */
class FilteredMeter implements Meter {
  private readonly inner: Meter;
  private readonly dropped: ReadonlySet<string>;

  constructor(inner: Meter, dropped: ReadonlySet<string>) {
    this.inner = inner;
    this.dropped = dropped;
  }

  private pick(name: string): Meter {
    return this.dropped.has(name) ? NOOP : this.inner;
  }

  createGauge(name: string, options?: MetricOptions): Gauge {
    return this.pick(name).createGauge(name, options);
  }

  createHistogram(name: string, options?: MetricOptions): Histogram {
    return this.pick(name).createHistogram(name, options);
  }

  createCounter(name: string, options?: MetricOptions): Counter {
    return this.pick(name).createCounter(name, options);
  }

  createUpDownCounter(name: string, options?: MetricOptions): UpDownCounter {
    return this.pick(name).createUpDownCounter(name, options);
  }

  createObservableGauge(name: string, options?: MetricOptions): ObservableGauge {
    return this.pick(name).createObservableGauge(name, options);
  }

  createObservableCounter(name: string, options?: MetricOptions): ObservableCounter {
    return this.pick(name).createObservableCounter(name, options);
  }

  createObservableUpDownCounter(name: string, options?: MetricOptions): ObservableUpDownCounter {
    return this.pick(name).createObservableUpDownCounter(name, options);
  }

  addBatchObservableCallback(callback: BatchObservableCallback, observables: Observable[]): void {
    this.inner.addBatchObservableCallback(callback, observables);
  }

  removeBatchObservableCallback(callback: BatchObservableCallback, observables: Observable[]): void {
    this.inner.removeBatchObservableCallback(callback, observables);
  }
}

/** A meter provider whose meters turn the instruments named in dropped into no-ops. */
export function withoutInstruments(provider: MeterProvider, dropped: readonly string[]): MeterProvider {
  const names = new Set(dropped);
  return {
    getMeter: (name: string, version?: string, options?: MeterOptions) =>
      new FilteredMeter(provider.getMeter(name, version, options), names),
  };
}

/** Options for startRuntimeMetrics. */
export interface RuntimeMetricsOptions {
  /** Make nodejs.eventloop.utilization a no-op. Default: true on Bun, false on Node. */
  readonly dropEventLoopUtilization?: boolean;
}

/**
 * Starts upstream's runtime instrumentation on meterProvider. It is built disabled, so nothing
 * registers on the global meter provider, then pointed at meterProvider and enabled. stop disables it.
 */
export function startRuntimeMetrics(
  meterProvider: MeterProvider,
  options: RuntimeMetricsOptions = {},
): RuntimeMetrics {
  const drop = options.dropEventLoopUtilization ?? "Bun" in globalThis;
  const instrumentation = new RuntimeNodeInstrumentation({ enabled: false });
  instrumentation.setMeterProvider(
    drop ? withoutInstruments(meterProvider, [EVENT_LOOP_UTILIZATION]) : meterProvider,
  );
  instrumentation.enable();
  return { stop: () => instrumentation.disable() };
}
