/**
 * OTLP JSON serialization of each signal, as strings.
 */
import { OtlpJsonMetricsSerializer, type ResourceMetricsWithExemplars } from "@libo11y/core";
import { JsonLogsSerializer, JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ResourceMetrics } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";

const decoder = new TextDecoder();

function text(bytes: Uint8Array | undefined): string {
  return bytes === undefined ? "{}" : decoder.decode(bytes);
}

/** The ExportTraceServiceRequest JSON for spans, through upstream's JsonTraceSerializer. */
export function serializeSpans(spans: readonly ReadableSpan[]): string {
  return text(JsonTraceSerializer.serializeRequest(spans as ReadableSpan[]));
}

/** The ExportLogsServiceRequest JSON for records, through upstream's JsonLogsSerializer. */
export function serializeLogs(records: readonly ReadableLogRecord[]): string {
  return text(JsonLogsSerializer.serializeRequest(records as ReadableLogRecord[]));
}

/** The ExportMetricsServiceRequest JSON, with exemplars, through core's OtlpJsonMetricsSerializer. */
export function serializeMetrics(rm: ResourceMetrics | ResourceMetricsWithExemplars): string {
  return text(OtlpJsonMetricsSerializer.serializeRequest(rm));
}
