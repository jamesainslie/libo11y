/**
 * The o11y.schema.violations counter: one count per attribute the policy drops or rewrites, by
 * signal and rule. It is created on the raw SDK MeterProvider, never through the policy-wrapping
 * provider, so recording a violation cannot itself be classified and recurse.
 */
import { ATTR_RULE, ATTR_SIGNAL, METRIC_SCHEMA_VIOLATIONS } from "@libo11y/spec";
import { type Counter, type MeterProvider, ROOT_CONTEXT, ValueType } from "@opentelemetry/api";
import type { ViolationSink } from "./policy.ts";
import { VERSION } from "./version.ts";

/** The instrumentation scope of the metrics and logs core itself emits. */
export const CORE_SCOPE = "@libo11y/core";

/** Counts specification violations on o11y.schema.violations. */
export class ViolationRecorder implements ViolationSink {
  private readonly counter: Counter | undefined;

  /** Creates the counter on meterProvider. A provider that fails leaves a recorder that counts nothing. */
  constructor(meterProvider: MeterProvider) {
    let counter: Counter | undefined;
    try {
      counter = meterProvider.getMeter(CORE_SCOPE, VERSION).createCounter(METRIC_SCHEMA_VIOLATIONS, {
        unit: "{violation}",
        description: "Telemetry records that violated the libo11y specification.",
        valueType: ValueType.INT,
      });
    } catch {
      counter = undefined;
    }
    this.counter = counter;
  }

  /**
   * Counts n violations of rule on signal in one measurement. The root context is deliberate: the
   * count has no use for exemplar linkage, and several callers run outside any record's context.
   */
  add(signal: string, rule: string, n: number): void {
    if (n <= 0) return;
    this.counter?.add(n, { [ATTR_SIGNAL]: signal, [ATTR_RULE]: rule }, ROOT_CONTEXT);
  }
}
