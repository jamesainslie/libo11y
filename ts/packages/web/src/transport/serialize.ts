/**
 * WP1 (transport). OTLP JSON serialization of each signal, as strings.
 */
import type { ResourceMetricsWithExemplars } from "@libo11y/core";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ResourceMetrics } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";

/** The ExportTraceServiceRequest JSON for spans, through upstream's JsonTraceSerializer. */
export function serializeSpans(spans: readonly ReadableSpan[]): string {
  void spans;
  throw new Error("not implemented");
}

/** The ExportLogsServiceRequest JSON for records, through upstream's JsonLogsSerializer. */
export function serializeLogs(records: readonly ReadableLogRecord[]): string {
  void records;
  throw new Error("not implemented");
}

/** The ExportMetricsServiceRequest JSON, with exemplars, through core's OtlpJsonMetricsSerializer. */
export function serializeMetrics(rm: ResourceMetrics | ResourceMetricsWithExemplars): string {
  void rm;
  throw new Error("not implemented");
}
