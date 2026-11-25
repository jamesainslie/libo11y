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
 *
 * With a recording gate, a measurement taken while the gate is closed is neither recorded nor
 * offered as an exemplar, and observable callbacks are not called.
 *
 * No measurement throws into the code that makes it. The attributes are read once, into an object
 * the library owns, in the same pass that classifies them: an attribute that cannot be read is
 * dropped and reported, and the measurement is recorded with the rest. The SDK and the exemplar
 * store then see that one reading, so a getter cannot answer them differently and a change the
 * caller makes afterwards does not reach the data point. A report goes to the telemetry's own
 * handler, and never repeats the message of what was thrown (internal/report.ts).
 *
 * The cost on the hot path is one small object per measurement, with one property write per
 * attribute kept. The keys were already listed once and each classified once, and still are, and
 * each value is read once where it used to be read by the SDK. Nothing is walked: an array value is
 * copied one level deep, and any other value is taken as it is.
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
import { globalErrorHandler } from "@opentelemetry/core";
import { type ExemplarKind, type ExemplarStore, scopeKey } from "./exemplars.ts";
import { gateOpen } from "./gate.ts";
import { type AttributeNoun, failure, type Report, unreadable } from "./internal/report.ts";
import type { RecordingGate } from "./platform.ts";
import type { SensitivityPolicy } from "./policy.ts";

const METRIC: AttributeNoun = { one: "metric attribute", all: "metric attributes" };

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
  private readonly report: Report;
  private readonly gate: RecordingGate | undefined;
  private readonly batchCallbacks = new WeakMap<BatchObservableCallback, BatchObservableCallback>();

  constructor(
    sdk: Meter,
    scope: string,
    policy: SensitivityPolicy,
    store: ExemplarStore,
    observables: ObservableMap,
    report: Report,
    gate?: RecordingGate,
  ) {
    this.sdk = sdk;
    this.scope = scope;
    this.policy = policy;
    this.store = store;
    this.observables = observables;
    this.report = report;
    this.gate = gate;
  }

  // classify reads a measurement's attributes once, into an object this meter owns, and keeps the
  // ones the policy keeps. A key the policy drops is never read. A value that cannot be read is
  // dropped and reported, and the loop goes on with the next key, so no value is read twice. It
  // never throws, whatever attrs is.
  private classify(attrs: Attributes | undefined): Attributes {
    const out: Record<string, unknown> = {};
    if (attrs === undefined || attrs === null) return out as Attributes;
    let keys: string[];
    try {
      keys = Object.keys(attrs);
    } catch (err) {
      this.report(failure(`o11y: ${METRIC.all} cannot be read and are dropped`, err));
      return out as Attributes;
    }
    const source = attrs as Record<string, unknown>;
    let i = 0;
    while (i < keys.length) {
      // One try for the whole set: entering it again costs something only after a failure.
      try {
        for (; i < keys.length; i++) {
          const k = keys[i] as string;
          if (!this.policy.keepsMetricKey(k)) continue;
          const v = source[k];
          // An array is the one attribute value that can change under the SDK after the call.
          out[k] = typeof v === "object" && v !== null && Array.isArray(v) ? v.slice() : v;
        }
      } catch (err) {
        this.report(unreadable(METRIC, [], keys[i] as string, err));
        i++;
      }
    }
    return out as Attributes;
  }

  // guarded runs one step of a measurement the application made. Whatever it throws is reported,
  // and the application's call returns as if nothing happened.
  private guarded(what: string, step: () => void): void {
    try {
      step();
    } catch (err) {
      this.report(failure(`o11y: ${what} failed, the measurement is dropped`, err));
    }
  }

  // measure classifies one synchronous measurement, records it on the SDK instrument with the
  // given or active context, and offers it as an exemplar. The function it returns never throws.
  private measure(
    record: (value: number, attrs: Attributes, ctx: Context) => void,
    name: string,
    kind: ExemplarKind,
    options: MetricOptions | undefined,
    nonNegative: boolean,
  ): (value: number, attrs?: Attributes, ctx?: Context) => void {
    const what = `recording on ${JSON.stringify(name)}`;
    return (value, attrs, ctx) => {
      if (!gateOpen(this.gate)) return;
      try {
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
        });
      } catch (err) {
        this.report(failure(`o11y: ${what} failed, the measurement is dropped`, err));
      }
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
        if (!gateOpen(this.gate)) return;
        const wrapped: BatchObservableResult = {
          observe: (metric, value, attrs) =>
            this.guarded("observing a metric", () =>
              result.observe(this.observables.get(metric) ?? metric, value, this.classify(attrs)),
            ),
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
        inner = (result: ObservableResult) => {
          if (!gateOpen(this.gate)) return;
          return callback({
            observe: (value, attrs) =>
              this.guarded("observing a metric", () => result.observe(value, this.classify(attrs))),
          });
        };
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
  private readonly report: Report;
  private readonly gate: RecordingGate | undefined;

  /**
   * Wraps the SDK provider sdk. Classifies with policy and offers measurements to exemplars. What a
   * measurement drops is reported to report: the telemetry's own handler, or without one the
   * OpenTelemetry global error handler. With gate, measurements and observable callbacks are
   * skipped while it is closed.
   */
  constructor(
    sdk: MeterProvider,
    policy: SensitivityPolicy,
    exemplars: ExemplarStore,
    report?: (err: unknown) => void,
    gate?: RecordingGate,
  ) {
    this.sdk = sdk;
    this.policy = policy;
    this.store = exemplars;
    this.gate = gate;
    const to = report ?? globalErrorHandler;
    this.report = (err) => {
      try {
        to(err);
      } catch {
        // The handler is the last resort; nothing is left to report to.
      }
    };
  }

  getMeter(name: string, version?: string, options?: MeterOptions): Meter {
    return new PolicyMeter(
      this.sdk.getMeter(name, version, options),
      scopeKey(name, version ?? "", options?.schemaUrl),
      this.policy,
      this.store,
      this.observables,
      this.report,
      this.gate,
    );
  }
}
