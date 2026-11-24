/**
 * OTLP/JSON metrics with exemplars. Upstream's JsonMetricsSerializer writes no exemplars, so this
 * serializer runs it, parses its output, and adds each data point's exemplars. For a collection
 * without exemplars the output is upstream's exactly. toOtlpMetricsObject exposes the same object
 * so a protobuf encoder can share it.
 */
import { type Attributes, type AttributeValue, ValueType } from "@opentelemetry/api";
import {
  type IExportMetricsServiceResponse,
  type ISerializer,
  JsonMetricsSerializer,
} from "@opentelemetry/otlp-transformer";
import { DataPointType, type MetricData, type ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { type Exemplar, exemplarsOf, type ResourceMetricsWithExemplars } from "./exemplars.ts";
import { base64Encode, utf8Decode, utf8Encode } from "./utf8.ts";

/** An OTLP/JSON AnyValue. */
export interface OtlpAnyValueJson {
  readonly stringValue?: string;
  readonly intValue?: number;
  readonly doubleValue?: number;
  readonly boolValue?: boolean;
  readonly bytesValue?: string;
  readonly arrayValue?: { readonly values: readonly OtlpAnyValueJson[] };
  readonly kvlistValue?: { readonly values: readonly OtlpKeyValueJson[] };
}

/** An OTLP/JSON KeyValue. */
export interface OtlpKeyValueJson {
  readonly key: string;
  readonly value: OtlpAnyValueJson;
}

/** An OTLP/JSON Exemplar. */
export interface OtlpExemplarJson {
  readonly filteredAttributes: readonly OtlpKeyValueJson[];
  /** Decimal nanoseconds since the epoch. */
  readonly timeUnixNano: string;
  readonly asDouble?: number;
  readonly asInt?: number;
  /** Lowercase hex. */
  readonly spanId?: string;
  readonly traceId?: string;
}

/** An OTLP/JSON data point of any kind, with the exemplars libo11y adds. */
export interface OtlpDataPointJson {
  readonly attributes: readonly OtlpKeyValueJson[];
  readonly startTimeUnixNano: string;
  readonly timeUnixNano: string;
  readonly exemplars?: readonly OtlpExemplarJson[];
  readonly [field: string]: unknown;
}

/** One OTLP/JSON data point list, as sum, gauge and both histogram kinds hold it. */
export interface OtlpDataPointsJson {
  readonly dataPoints: readonly OtlpDataPointJson[];
  readonly aggregationTemporality?: number;
  readonly isMonotonic?: boolean;
}

/** An OTLP/JSON Metric. Exactly one of sum, gauge, histogram and exponentialHistogram is set. */
export interface OtlpMetricJson {
  readonly name: string;
  readonly description?: string;
  readonly unit?: string;
  readonly sum?: OtlpDataPointsJson;
  readonly gauge?: OtlpDataPointsJson;
  readonly histogram?: OtlpDataPointsJson;
  readonly exponentialHistogram?: OtlpDataPointsJson;
}

/** An OTLP/JSON ScopeMetrics. */
export interface OtlpScopeMetricsJson {
  readonly scope: {
    readonly name: string;
    readonly version?: string;
    readonly attributes?: readonly OtlpKeyValueJson[];
    readonly droppedAttributesCount?: number;
  };
  readonly metrics: readonly OtlpMetricJson[];
  readonly schemaUrl?: string;
}

/** An OTLP/JSON ResourceMetrics. */
export interface OtlpResourceMetricsJson {
  readonly resource: {
    readonly attributes: readonly OtlpKeyValueJson[];
    readonly droppedAttributesCount: number;
  };
  readonly schemaUrl?: string;
  readonly scopeMetrics: readonly OtlpScopeMetricsJson[];
}

/** The OTLP/JSON ExportMetricsServiceRequest. */
export interface OtlpMetricsRequestJson {
  readonly resourceMetrics: readonly OtlpResourceMetricsJson[];
}

// toAnyValue encodes a value as upstream's toAnyValue does with its JSON encoder.
function toAnyValue(value: unknown): OtlpAnyValueJson {
  switch (typeof value) {
    case "string":
      return { stringValue: value };
    case "number":
      return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
    case "boolean":
      return { boolValue: value };
  }
  if (value instanceof Uint8Array) return { bytesValue: base64Encode(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toAnyValue) } };
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    return { kvlistValue: { values: Object.keys(obj).map((key) => ({ key, value: toAnyValue(obj[key]) })) } };
  }
  return {};
}

function toAttributes(attrs: Attributes): OtlpKeyValueJson[] {
  return Object.keys(attrs).map((key) => ({ key, value: toAnyValue(attrs[key] as AttributeValue) }));
}

function toExemplarJson(e: Exemplar, valueType: ValueType): OtlpExemplarJson {
  return {
    filteredAttributes: toAttributes(e.filteredAttributes),
    timeUnixNano: e.timeUnixNano.toString(),
    ...(valueType === ValueType.INT ? { asInt: e.value } : { asDouble: e.value }),
    ...(e.traceId === undefined ? {} : { spanId: e.spanId as string, traceId: e.traceId }),
  };
}

function pointsField(metric: MetricData): keyof OtlpMetricJson {
  switch (metric.dataPointType) {
    case DataPointType.SUM:
      return "sum";
    case DataPointType.GAUGE:
      return "gauge";
    case DataPointType.HISTOGRAM:
      return "histogram";
    default:
      return "exponentialHistogram";
  }
}

/**
 * The OTLP/JSON request object for rm: upstream's JSON form, with each data point's exemplars
 * added as an `exemplars` array where it has any.
 */
export function toOtlpMetricsObject(rm: ResourceMetricsWithExemplars): OtlpMetricsRequestJson {
  const bytes = JsonMetricsSerializer.serializeRequest(rm) ?? new Uint8Array(0);
  const request = JSON.parse(utf8Decode(bytes)) as OtlpMetricsRequestJson;
  const [resourceJson] = request.resourceMetrics;
  if (resourceJson === undefined) return request;
  rm.scopeMetrics.forEach((sm, s) => {
    const scopeJson = resourceJson.scopeMetrics[s];
    sm.metrics.forEach((metric, m) => {
      const holder = scopeJson?.metrics[m]?.[pointsField(metric)] as OtlpDataPointsJson | undefined;
      metric.dataPoints.forEach((point, p) => {
        const exemplars = exemplarsOf(point);
        const pointJson = holder?.dataPoints[p] as { exemplars?: OtlpExemplarJson[] } | undefined;
        if (exemplars.length === 0 || pointJson === undefined) return;
        pointJson.exemplars = exemplars.map((e) => toExemplarJson(e, metric.descriptor.valueType));
      });
    });
  });
  return request;
}

/** OTLP/JSON metrics with exemplars, for upstream's OTLP HTTP export delegate. */
export const OtlpJsonMetricsSerializer: ISerializer<
  ResourceMetrics | ResourceMetricsWithExemplars,
  IExportMetricsServiceResponse
> = {
  serializeRequest: (rm) => utf8Encode(JSON.stringify(toOtlpMetricsObject(rm))),
  deserializeResponse: (data) => JsonMetricsSerializer.deserializeResponse(data),
};
