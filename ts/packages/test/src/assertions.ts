/**
 * The checks behind the recorder's assertions, as pure functions over recorded telemetry. Each
 * returns its problems as messages in the wording of Go's o11ytest and internal/conformance; the
 * recorder throws them together as one AssertionError.
 */
import { AssertionError } from "node:assert";
import type { ResourceMetricsWithExemplars } from "@libo11y/core";
import {
  ATTR_RULE,
  ATTR_SIGNAL,
  EVENTS,
  goQuote,
  METRIC_SCHEMA_VIOLATIONS,
  REQUIRED_TIER0,
  SENSITIVITY_OF,
  SIGNAL_VALUE_RESOURCE,
} from "@libo11y/spec";
import type { Attributes, SpanContext } from "@opentelemetry/api";
import type { DataPoint } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { RecordedExemplar, RecordedLog } from "./recorder.ts";

/** The rule o11y.schema.violations records when classification removes a secret attribute. */
const SECRET_ATTRIBUTE_RULE = "secret_attribute";

/** A recorded log with the valid span context active when it was emitted, as Go's logCapture keeps it. */
export interface CapturedLog {
  readonly log: RecordedLog;
  readonly active: SpanContext | undefined;
}

/** Throws one AssertionError whose message is every problem, one per line. */
export function fail(problems: readonly string[]): never {
  throw new AssertionError({ message: problems.join("\n") });
}

function isGroup(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

/**
 * The dotted key of every leaf under attributes, joining group names with "." as the library's
 * classification does. An empty-key group is inlined into its parent; arrays and bytes are leaves.
 */
export function leafKeys(attributes: Readonly<Record<string, unknown>>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(attributes)) {
    const key = k === "" ? prefix : prefix === "" ? k : `${prefix}.${k}`;
    if (isGroup(v)) out.push(...leafKeys(v, key));
    else out.push(key);
  }
  return out;
}

/**
 * Every way a record for the named event, carrying keys, violates its registered contract, as Go's
 * conformance.CheckEvent reports it. An unregistered name has no contract.
 */
export function checkEvent(name: string, keys: readonly string[]): string[] {
  const info = EVENTS.get(name);
  if (info === undefined) return [];
  const present = new Set(keys);
  const problems: string[] = [];
  for (const req of info.required) {
    if (!present.has(req)) problems.push(`event ${name}: missing required attribute ${req}`);
  }
  for (const tmpl of info.requiredTemplates) {
    const prefix = `${tmpl}.`;
    // A bare "<template>." carries no key, so it does not satisfy the template.
    if (!keys.some((k) => k.length > prefix.length && k.startsWith(prefix))) {
      problems.push(`event ${name}: missing required template attribute ${prefix}<key>`);
    }
  }
  return problems;
}

function isSecret(key: string): boolean {
  return SENSITIVITY_OF.get(key) === "secret";
}

/** The positive o11y.schema.violations counts for rule, summed by o11y.signal. */
export function violationsBySignal(rm: ResourceMetricsWithExemplars, rule: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const sm of rm.scopeMetrics) {
    for (const metric of sm.metrics) {
      if (metric.descriptor.name !== METRIC_SCHEMA_VIOLATIONS) continue;
      for (const point of metric.dataPoints as DataPoint<unknown>[]) {
        const value = point.value;
        if (point.attributes[ATTR_RULE] !== rule || typeof value !== "number" || value <= 0) continue;
        const signal = String(point.attributes[ATTR_SIGNAL] ?? "");
        totals.set(signal, (totals.get(signal) ?? 0) + value);
      }
    }
  }
  return totals;
}

/** What assertConforms checks. metrics is absent when collecting failed. */
export interface ConformanceInput {
  readonly resource: Attributes;
  readonly metrics?: ResourceMetricsWithExemplars;
  readonly logs: readonly RecordedLog[];
  readonly spans: readonly ReadableSpan[];
  /** Problems found before the checks, such as a failed flush, reported after the tier-0 keys. */
  readonly preflight?: readonly string[];
}

/**
 * Go AssertConforms after its flush: tier-0 resource keys, secret_attribute violations by signal,
 * spec-table secrets in the clear on logs and span attributes, and registered event contracts.
 */
export function conformanceProblems(input: ConformanceInput): string[] {
  const problems: string[] = [];
  for (const key of REQUIRED_TIER0) {
    if (!Object.hasOwn(input.resource, key)) {
      problems.push(`o11ytest: resource missing required tier-0 attribute ${goQuote(key)}`);
    }
  }
  problems.push(...(input.preflight ?? []));

  if (input.metrics !== undefined) {
    const bySignal = violationsBySignal(input.metrics, SECRET_ATTRIBUTE_RULE);
    for (const signal of [...bySignal.keys()].sort()) {
      const n = bySignal.get(signal) ?? 0;
      if (signal === SIGNAL_VALUE_RESOURCE) {
        problems.push(
          "o11ytest: options passed to createRecorder put a secret-classified attribute on the resource " +
            `(${n} redaction(s) counted); it was redacted, but secrets must never be emitted`,
        );
        continue;
      }
      problems.push(
        `o11ytest: the code under test emitted secret-classified attributes on ${signal} ` +
          `(${n} redaction(s) counted); they were redacted, but secrets must never be emitted`,
      );
    }
  }

  // These read only the specification table, so a key an application registry classifies secret
  // is not checked here. The violation count above does see it.
  for (const log of input.logs) {
    const keys = leafKeys(log.attributes);
    for (const key of keys) {
      if (isSecret(key)) {
        problems.push(
          `o11ytest: log record ${goQuote(log.body)} carries secret-classified attribute ${goQuote(key)} in the clear`,
        );
      }
    }
    if (log.eventName !== undefined) {
      for (const problem of checkEvent(log.eventName, keys)) problems.push(`o11ytest: ${problem}`);
    }
  }

  for (const span of input.spans) {
    for (const key of Object.keys(span.attributes)) {
      if (isSecret(key)) {
        problems.push(
          `o11ytest: span ${goQuote(span.name)} carries secret-classified attribute ${goQuote(key)} in the clear`,
        );
      }
    }
  }
  return problems;
}

/**
 * Go AssertCorrelated: a record emitted while a span was active must carry that span's trace ID.
 * "active" is the caller's active span at emission, not the context the emitter passed.
 */
export function correlationProblems(logs: readonly CapturedLog[]): string[] {
  const problems: string[] = [];
  for (const { log, active } of logs) {
    if (active === undefined) continue;
    if (log.traceId === undefined) {
      problems.push(`o11ytest: correlated record ${goQuote(log.body)} has no trace_id attribute`);
      continue;
    }
    if (log.traceId !== active.traceId) {
      problems.push(
        `o11ytest: record ${goQuote(log.body)} trace_id ${goQuote(log.traceId)} does not match its span ` +
          goQuote(active.traceId),
      );
    }
  }
  return problems;
}

/**
 * The correlation triangle: a recorded span, a log carrying its trace and span IDs, and an
 * exemplar on metric carrying that trace ID.
 */
export function triangleProblems(
  metric: string,
  spans: readonly ReadableSpan[],
  logs: readonly RecordedLog[],
  exemplars: readonly RecordedExemplar[],
): string[] {
  if (spans.length === 0) return ["o11ytest: triangle: no span was recorded"];
  const traceOf = new Map(spans.map((s) => [s.spanContext().spanId, s.spanContext().traceId]));
  const traces = new Set(
    logs
      .filter((l) => l.spanId !== undefined && l.traceId !== undefined && traceOf.get(l.spanId) === l.traceId)
      .map((l) => l.traceId),
  );
  if (traces.size === 0) {
    return [
      `o11ytest: triangle: none of ${logs.length} log record(s) carries the trace and span IDs of one of ` +
        `${spans.length} recorded span(s)`,
    ];
  }
  if (exemplars.length === 0) return [`o11ytest: triangle: no exemplar recorded on ${goQuote(metric)}`];
  if (!exemplars.some((e) => e.traceId !== undefined && traces.has(e.traceId))) {
    return [
      `o11ytest: triangle: none of ${exemplars.length} exemplar(s) on ${goQuote(metric)} carries the trace ID ` +
        "of a span with a correlated log record",
    ];
  }
  return [];
}
