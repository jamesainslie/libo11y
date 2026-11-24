/**
 * The OTLP subset the sink decodes, as protowire schemas: the three Export*ServiceRequest messages
 * of opentelemetry-proto v1, with every field upstream's protobuf serializers emit plus the metric
 * exemplars (NumberDataPoint field 5, HistogramDataPoint field 8, ExponentialHistogramDataPoint
 * field 11), summaries, and the trace and log fields upstream leaves out. Field names are the
 * OTLP/JSON (lowerCamelCase) names.
 */
import { decodeMessage, type FieldSchema, type MessageSchema } from "./protowire.ts";

/** An OTLP signal, as the sink's paths name it. */
export type OtlpSignal = "traces" | "metrics" | "logs";

// keyValues is a repeated KeyValue field, as every attribute list is.
function keyValues(name: string): FieldSchema {
  return { name, type: "message", message: "KeyValue", repeated: true };
}

const SCHEMAS: Readonly<Record<string, MessageSchema>> = {
  // common/v1
  AnyValue: {
    1: { name: "stringValue", type: "string" },
    2: { name: "boolValue", type: "bool" },
    3: { name: "intValue", type: "int64" },
    4: { name: "doubleValue", type: "double" },
    5: { name: "arrayValue", type: "message", message: "ArrayValue" },
    6: { name: "kvlistValue", type: "message", message: "KeyValueList" },
    7: { name: "bytesValue", type: "base64" },
  },
  ArrayValue: { 1: { name: "values", type: "message", message: "AnyValue", repeated: true } },
  KeyValueList: { 1: { name: "values", type: "message", message: "KeyValue", repeated: true } },
  KeyValue: {
    1: { name: "key", type: "string" },
    2: { name: "value", type: "message", message: "AnyValue" },
  },
  InstrumentationScope: {
    1: { name: "name", type: "string" },
    2: { name: "version", type: "string" },
    3: keyValues("attributes"),
    4: { name: "droppedAttributesCount", type: "uint32" },
  },
  // resource/v1
  Resource: {
    1: keyValues("attributes"),
    2: { name: "droppedAttributesCount", type: "uint32" },
  },

  // collector/trace/v1 and trace/v1
  ExportTraceServiceRequest: {
    1: { name: "resourceSpans", type: "message", message: "ResourceSpans", repeated: true },
  },
  ResourceSpans: {
    1: { name: "resource", type: "message", message: "Resource" },
    2: { name: "scopeSpans", type: "message", message: "ScopeSpans", repeated: true },
    3: { name: "schemaUrl", type: "string" },
  },
  ScopeSpans: {
    1: { name: "scope", type: "message", message: "InstrumentationScope" },
    2: { name: "spans", type: "message", message: "Span", repeated: true },
    3: { name: "schemaUrl", type: "string" },
  },
  Span: {
    1: { name: "traceId", type: "hex" },
    2: { name: "spanId", type: "hex" },
    3: { name: "traceState", type: "string" },
    4: { name: "parentSpanId", type: "hex" },
    5: { name: "name", type: "string" },
    6: { name: "kind", type: "int32" },
    7: { name: "startTimeUnixNano", type: "time" },
    8: { name: "endTimeUnixNano", type: "time" },
    9: keyValues("attributes"),
    10: { name: "droppedAttributesCount", type: "uint32" },
    11: { name: "events", type: "message", message: "SpanEvent", repeated: true },
    12: { name: "droppedEventsCount", type: "uint32" },
    13: { name: "links", type: "message", message: "SpanLink", repeated: true },
    14: { name: "droppedLinksCount", type: "uint32" },
    15: { name: "status", type: "message", message: "Status" },
    16: { name: "flags", type: "fixed32" },
  },
  SpanEvent: {
    1: { name: "timeUnixNano", type: "time" },
    2: { name: "name", type: "string" },
    3: keyValues("attributes"),
    4: { name: "droppedAttributesCount", type: "uint32" },
  },
  SpanLink: {
    1: { name: "traceId", type: "hex" },
    2: { name: "spanId", type: "hex" },
    3: { name: "traceState", type: "string" },
    4: keyValues("attributes"),
    5: { name: "droppedAttributesCount", type: "uint32" },
    6: { name: "flags", type: "fixed32" },
  },
  Status: {
    2: { name: "message", type: "string" },
    3: { name: "code", type: "int32" },
  },

  // collector/metrics/v1 and metrics/v1
  ExportMetricsServiceRequest: {
    1: { name: "resourceMetrics", type: "message", message: "ResourceMetrics", repeated: true },
  },
  ResourceMetrics: {
    1: { name: "resource", type: "message", message: "Resource" },
    2: { name: "scopeMetrics", type: "message", message: "ScopeMetrics", repeated: true },
    3: { name: "schemaUrl", type: "string" },
  },
  ScopeMetrics: {
    1: { name: "scope", type: "message", message: "InstrumentationScope" },
    2: { name: "metrics", type: "message", message: "Metric", repeated: true },
    3: { name: "schemaUrl", type: "string" },
  },
  Metric: {
    1: { name: "name", type: "string" },
    2: { name: "description", type: "string" },
    3: { name: "unit", type: "string" },
    5: { name: "gauge", type: "message", message: "Gauge" },
    7: { name: "sum", type: "message", message: "Sum" },
    9: { name: "histogram", type: "message", message: "Histogram" },
    10: { name: "exponentialHistogram", type: "message", message: "ExponentialHistogram" },
    11: { name: "summary", type: "message", message: "Summary" },
    12: keyValues("metadata"),
  },
  Gauge: { 1: { name: "dataPoints", type: "message", message: "NumberDataPoint", repeated: true } },
  Sum: {
    1: { name: "dataPoints", type: "message", message: "NumberDataPoint", repeated: true },
    2: { name: "aggregationTemporality", type: "int32" },
    3: { name: "isMonotonic", type: "bool" },
  },
  Histogram: {
    1: { name: "dataPoints", type: "message", message: "HistogramDataPoint", repeated: true },
    2: { name: "aggregationTemporality", type: "int32" },
  },
  ExponentialHistogram: {
    1: { name: "dataPoints", type: "message", message: "ExponentialHistogramDataPoint", repeated: true },
    2: { name: "aggregationTemporality", type: "int32" },
  },
  Summary: { 1: { name: "dataPoints", type: "message", message: "SummaryDataPoint", repeated: true } },
  NumberDataPoint: {
    7: keyValues("attributes"),
    2: { name: "startTimeUnixNano", type: "time" },
    3: { name: "timeUnixNano", type: "time" },
    4: { name: "asDouble", type: "double" },
    6: { name: "asInt", type: "sfixed64" },
    5: { name: "exemplars", type: "message", message: "Exemplar", repeated: true },
    8: { name: "flags", type: "uint32" },
  },
  HistogramDataPoint: {
    9: keyValues("attributes"),
    2: { name: "startTimeUnixNano", type: "time" },
    3: { name: "timeUnixNano", type: "time" },
    4: { name: "count", type: "fixed64" },
    5: { name: "sum", type: "double" },
    6: { name: "bucketCounts", type: "fixed64", repeated: true },
    7: { name: "explicitBounds", type: "double", repeated: true },
    8: { name: "exemplars", type: "message", message: "Exemplar", repeated: true },
    10: { name: "flags", type: "uint32" },
    11: { name: "min", type: "double" },
    12: { name: "max", type: "double" },
  },
  ExponentialHistogramDataPoint: {
    1: keyValues("attributes"),
    2: { name: "startTimeUnixNano", type: "time" },
    3: { name: "timeUnixNano", type: "time" },
    4: { name: "count", type: "fixed64" },
    5: { name: "sum", type: "double" },
    6: { name: "scale", type: "sint32" },
    7: { name: "zeroCount", type: "fixed64" },
    8: { name: "positive", type: "message", message: "Buckets" },
    9: { name: "negative", type: "message", message: "Buckets" },
    10: { name: "flags", type: "uint32" },
    11: { name: "exemplars", type: "message", message: "Exemplar", repeated: true },
    12: { name: "min", type: "double" },
    13: { name: "max", type: "double" },
    14: { name: "zeroThreshold", type: "double" },
  },
  Buckets: {
    1: { name: "offset", type: "sint32" },
    2: { name: "bucketCounts", type: "uint64", repeated: true },
  },
  SummaryDataPoint: {
    7: keyValues("attributes"),
    2: { name: "startTimeUnixNano", type: "time" },
    3: { name: "timeUnixNano", type: "time" },
    4: { name: "count", type: "fixed64" },
    5: { name: "sum", type: "double" },
    6: { name: "quantileValues", type: "message", message: "ValueAtQuantile", repeated: true },
    8: { name: "flags", type: "uint32" },
  },
  ValueAtQuantile: {
    1: { name: "quantile", type: "double" },
    2: { name: "value", type: "double" },
  },
  Exemplar: {
    7: keyValues("filteredAttributes"),
    2: { name: "timeUnixNano", type: "time" },
    3: { name: "asDouble", type: "double" },
    6: { name: "asInt", type: "sfixed64" },
    4: { name: "spanId", type: "hex" },
    5: { name: "traceId", type: "hex" },
  },

  // collector/logs/v1 and logs/v1
  ExportLogsServiceRequest: {
    1: { name: "resourceLogs", type: "message", message: "ResourceLogs", repeated: true },
  },
  ResourceLogs: {
    1: { name: "resource", type: "message", message: "Resource" },
    2: { name: "scopeLogs", type: "message", message: "ScopeLogs", repeated: true },
    3: { name: "schemaUrl", type: "string" },
  },
  ScopeLogs: {
    1: { name: "scope", type: "message", message: "InstrumentationScope" },
    2: { name: "logRecords", type: "message", message: "LogRecord", repeated: true },
    3: { name: "schemaUrl", type: "string" },
  },
  LogRecord: {
    1: { name: "timeUnixNano", type: "time" },
    11: { name: "observedTimeUnixNano", type: "time" },
    2: { name: "severityNumber", type: "int32" },
    3: { name: "severityText", type: "string" },
    5: { name: "body", type: "message", message: "AnyValue" },
    6: keyValues("attributes"),
    7: { name: "droppedAttributesCount", type: "uint32" },
    8: { name: "flags", type: "fixed32" },
    9: { name: "traceId", type: "hex" },
    10: { name: "spanId", type: "hex" },
    12: { name: "eventName", type: "string" },
  },
};

const REQUEST: Readonly<Record<OtlpSignal, string>> = {
  traces: "ExportTraceServiceRequest",
  metrics: "ExportMetricsServiceRequest",
  logs: "ExportLogsServiceRequest",
};

/**
 * Decodes an OTLP/HTTP protobuf request body for signal into its OTLP/JSON shape: IDs are lowercase
 * hex, *UnixNano timestamps decimal strings, other 64-bit integers numbers when safe (else decimal
 * strings), bytes values base64 and enums numbers. Throws on malformed input.
 */
export function decodeOtlpProtobuf(signal: OtlpSignal, body: Uint8Array): Record<string, unknown> {
  return decodeMessage(SCHEMAS, REQUEST[signal], body);
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === 0 || v === false || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return typeof v === "object" && Object.keys(v as object).length === 0;
}

/**
 * Normalizes an OTLP/JSON-shaped value so a decoded protobuf payload and the equivalent JSON
 * payload compare equal:
 * - a field whose value is a proto3 default (undefined, null, 0, false, ""), an empty list or an
 *   empty object after normalization is removed, because protobuf does not carry it and upstream's
 *   JSON serializers write some of them;
 * - `schemaUrl` inside a `resource` is removed: upstream's JSON writes it there as well as on the
 *   Resource* message, but the OTLP Resource message has no such field.
 * List elements are normalized but never removed, so bucket counts keep their zeros.
 */
export function normalizeOtlp(value: unknown): unknown {
  return normalize(value, "");
}

function normalize(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map((v) => normalize(v, ""));
  if (typeof value !== "object" || value === null || value instanceof Uint8Array) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (key === "resource" && k === "schemaUrl") continue;
    const n = normalize(v, k);
    if (!isEmpty(n)) out[k] = n;
  }
  return out;
}
