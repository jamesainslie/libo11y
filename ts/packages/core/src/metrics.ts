/**
 * Metric enforcement. PolicyMeterProvider wraps the SDK MeterProvider so every measurement's
 * attributes are classified before the SDK sees them: secrets are dropped, PII is dropped unless the
 * PII mode is allow, and nothing is tokenized, because a token per value would multiply series.
 * Classifying at record time covers every stream a view derives, without a catch-all view. Metric
 * classification is never counted, as in Go.
 *
 * Each synchronous measurement is also offered to the ExemplarStore with its context. Observable
 * instruments are created on the SDK meter and their callbacks get a classifying ObservableResult;
 * they offer no exemplars, as they carry no measurement context.
 */
import {
  type Attributes,
  type BatchObservableCallback,
  type BatchObservableResult,
  type Context,
  type Counter,
  context,
  type Gauge,
  type Histogram,
  type Meter,
  type MeterOptions,
  type MeterProvider,
  type MetricOptions,
  type Observable,
  type ObservableCallback,
  type ObservableResult,
  type UpDownCounter,
  ValueType,
} from "@opentelemetry/api";
import { type ExemplarKind, type ExemplarStore, scopeKey } from "./exemplars.ts";
import type { SensitivityPolicy } from "./policy.ts";

/** Maps each wrapper observable to the SDK observable it fronts. */
type ObservableMap = WeakMap<Observable, Observable>;

// recordedValue returns the value the SDK records for a measurement, or undefined when the SDK
// rejects it, so only recorded measurements become exemplars.
function recordedValue(
  value: number,
  valueType: ValueType | undefined,
  nonNegative: boolean,
): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  if (nonNegative && value < 0) return undefined;
  if (valueType === ValueType.INT && !Number.isInteger(value)) {
    const v = Math.trunc(value);
    return Number.isInteger(v) ? v : undefined;
  }
  return value;
}

class PolicyMeter implements Meter {
  private readonly sdk: Meter;
  private readonly scope: string;
  private readonly policy: SensitivityPolicy;
  private readonly store: ExemplarStore;
  private readonly observables: ObservableMap;
  private readonly batchCallbacks = new WeakMap<BatchObservableCallback, BatchObservableCallback>();

  constructor(
    sdk: Meter,
    scope: string,
    policy: SensitivityPolicy,
    store: ExemplarStore,
    observables: ObservableMap,
  ) {
    this.sdk = sdk;
    this.scope = scope;
    this.policy = policy;
    this.store = store;
    this.observables = observables;
  }

  private classify(attrs: Attributes | undefined): Attributes {
    return this.policy.metricAttributes(attrs ?? {});
  }

  // measure classifies one synchronous measurement, records it on the SDK instrument with the
  // given or active context, and offers it as an exemplar.
  private measure(
    record: (value: number, attrs: Attributes, ctx: Context) => void,
    name: string,
    kind: ExemplarKind,
    options: MetricOptions | undefined,
    nonNegative: boolean,
  ): (value: number, attrs?: Attributes, ctx?: Context) => void {
    const advised = options?.advice?.explicitBucketBoundaries;
    return (value, attrs, ctx) => {
      const classified = this.classify(attrs);
      const active = ctx ?? context.active();
      record(value, classified, active);
      const v = recordedValue(value, options?.valueType, nonNegative);
      if (v === undefined) return;
      this.store.offer({
        scope: this.scope,
        instrument: name,
        kind,
        value: v,
        attributes: classified,
        context: active,
        ...(kind === "histogram" && advised !== undefined ? { advisedBuckets: advised } : {}),
      });
    };
  }

  createCounter(name: string, options?: MetricOptions): Counter {
    const inner = this.sdk.createCounter(name, options);
    const add = this.measure((v, a, c) => inner.add(v, a, c), name, "sum", options, true);
    return { add };
  }

  createUpDownCounter(name: string, options?: MetricOptions): UpDownCounter {
    const inner = this.sdk.createUpDownCounter(name, options);
    const add = this.measure((v, a, c) => inner.add(v, a, c), name, "sum", options, false);
    return { add };
  }

  createHistogram(name: string, options?: MetricOptions): Histogram {
    const inner = this.sdk.createHistogram(name, options);
    const record = this.measure((v, a, c) => inner.record(v, a, c), name, "histogram", options, true);
    return { record };
  }

  createGauge(name: string, options?: MetricOptions): Gauge {
    const inner = this.sdk.createGauge(name, options);
    const record = this.measure((v, a, c) => inner.record(v, a, c), name, "gauge", options, false);
    return { record };
  }

  createObservableGauge(name: string, options?: MetricOptions): Observable {
    return this.wrapObservable(this.sdk.createObservableGauge(name, options));
  }

  createObservableCounter(name: string, options?: MetricOptions): Observable {
    return this.wrapObservable(this.sdk.createObservableCounter(name, options));
  }

  createObservableUpDownCounter(name: string, options?: MetricOptions): Observable {
    return this.wrapObservable(this.sdk.createObservableUpDownCounter(name, options));
  }

  addBatchObservableCallback(callback: BatchObservableCallback, observables: Observable[]): void {
    this.sdk.addBatchObservableCallback(this.batchCallback(callback), this.unwrap(observables));
  }

  removeBatchObservableCallback(callback: BatchObservableCallback, observables: Observable[]): void {
    const inner = this.batchCallbacks.get(callback);
    if (inner !== undefined) this.sdk.removeBatchObservableCallback(inner, this.unwrap(observables));
  }

  private unwrap(observables: readonly Observable[]): Observable[] {
    return observables.map((o) => this.observables.get(o) ?? o);
  }

  // batchCallback returns the one SDK callback that fronts callback, so add and remove agree.
  private batchCallback(callback: BatchObservableCallback): BatchObservableCallback {
    let inner = this.batchCallbacks.get(callback);
    if (inner === undefined) {
      inner = (result: BatchObservableResult) => {
        const wrapped: BatchObservableResult = {
          observe: (metric, value, attrs) =>
            result.observe(this.observables.get(metric) ?? metric, value, this.classify(attrs)),
        };
        return callback(wrapped);
      };
      this.batchCallbacks.set(callback, inner);
    }
    return inner;
  }

  private wrapObservable(sdk: Observable): Observable {
    const callbacks = new WeakMap<ObservableCallback, ObservableCallback>();
    const front = (callback: ObservableCallback): ObservableCallback => {
      let inner = callbacks.get(callback);
      if (inner === undefined) {
        inner = (result: ObservableResult) =>
          callback({ observe: (value, attrs) => result.observe(value, this.classify(attrs)) });
        callbacks.set(callback, inner);
      }
      return inner;
    };
    const wrapper: Observable = {
      addCallback: (callback) => sdk.addCallback(front(callback)),
      removeCallback: (callback) => {
        const inner = callbacks.get(callback);
        if (inner !== undefined) sdk.removeCallback(inner);
      },
    };
    this.observables.set(wrapper, sdk);
    return wrapper;
  }
}

/** A MeterProvider that classifies every measurement and samples exemplars from it. */
export class PolicyMeterProvider implements MeterProvider {
  private readonly sdk: MeterProvider;
  private readonly policy: SensitivityPolicy;
  private readonly store: ExemplarStore;
  private readonly observables: ObservableMap = new WeakMap();

  /** Wraps the SDK provider sdk. Classifies with policy and offers measurements to exemplars. */
  constructor(sdk: MeterProvider, policy: SensitivityPolicy, exemplars: ExemplarStore) {
    this.sdk = sdk;
    this.policy = policy;
    this.store = exemplars;
  }

  getMeter(name: string, version?: string, options?: MeterOptions): Meter {
    return new PolicyMeter(
      this.sdk.getMeter(name, version, options),
      scopeKey(name, version ?? "", options?.schemaUrl),
      this.policy,
      this.store,
      this.observables,
    );
  }
}
