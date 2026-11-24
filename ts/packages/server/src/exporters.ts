/**
 * The exporters for each signal core routes to otlp or console. Upstream's OTLP exporters read
 * their own OTEL_EXPORTER_OTLP_* variables (endpoint, headers, timeout, compression, certificates),
 * so they are built with no options. The metric exporter is upstream's OTLPMetricExporterBase over
 * upstream's OTLP HTTP export delegate, configured exactly as upstream's own OTLPMetricExporter
 * configures it, but with libo11y's serializers, which write exemplars: protobuf from this package,
 * JSON from core. Both metric routes wrap the exporter with exemplarMetricExporter, so each
 * collection carries the exemplar store's samples.
 */
import {
  type ExporterRequest,
  type ExporterSet,
  exemplarMetricExporter,
  O11yError,
  OtlpJsonMetricsSerializer,
} from "@libo11y/core";
import { OTLPLogExporter as OTLPJsonLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as OTLPProtoLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporterBase } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter as OTLPJsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as OTLPProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  convertLegacyHttpOptions,
  createOtlpHttpExportDelegate,
} from "@opentelemetry/otlp-exporter-base/node-http";
import { MetricsExporterMetricsHelper } from "@opentelemetry/otlp-transformer";
import { ConsoleLogRecordExporter, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import {
  ConsoleMetricExporter,
  type IMetricReader,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { ConsoleSpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace";
import { OtlpProtobufMetricsSerializer } from "./otlp-proto-metrics.ts";

/** The otel.component.type upstream's OTLP HTTP metric exporter reports. */
const METRIC_EXPORTER_COMPONENT = "otlp_http_metric_exporter";

type ExporterKind = "span exporter" | "metric reader" | "log exporter";

// build runs a constructor and reports a failure as Go's "o11y: building <kind>: %w".
function build<T>(kind: ExporterKind, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new O11yError(
      "EXPORTER",
      `o11y: building ${kind}: ${err instanceof Error ? err.message : String(err)}`,
      {
        cause: err,
      },
    );
  }
}

/**
 * The OTLP metric exporter for protocol: upstream's construction (convertLegacyHttpOptions for
 * METRICS and v1/metrics, so the shared and metric-specific variables apply, and the temporality
 * preference from OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE) with libo11y's serializer.
 */
function otlpMetricExporter(protocol: string): PushMetricExporter {
  const protobuf = protocol === "http/protobuf";
  const options = convertLegacyHttpOptions({}, "METRICS", "v1/metrics", {
    "Content-Type": protobuf ? "application/x-protobuf" : "application/json",
  });
  const serializer = protobuf ? OtlpProtobufMetricsSerializer : OtlpJsonMetricsSerializer;
  return new OTLPMetricExporterBase(
    createOtlpHttpExportDelegate(
      options,
      serializer,
      METRIC_EXPORTER_COMPONENT,
      MetricsExporterMetricsHelper,
      undefined,
    ),
  );
}

function spanExporter(req: ExporterRequest): SpanExporter | undefined {
  const { traces, protocol } = req.config;
  if (traces === "console") return new ConsoleSpanExporter();
  if (traces !== "otlp") return undefined;
  return build("span exporter", () =>
    protocol.traces === "http/json" ? new OTLPJsonTraceExporter() : new OTLPProtoTraceExporter(),
  );
}

function logExporter(req: ExporterRequest): LogRecordExporter | undefined {
  const { logs, protocol } = req.config;
  if (logs === "console") return new ConsoleLogRecordExporter();
  if (logs !== "otlp") return undefined;
  return build("log exporter", () =>
    protocol.logs === "http/json" ? new OTLPJsonLogExporter() : new OTLPProtoLogExporter(),
  );
}

function metricReader(req: ExporterRequest): IMetricReader | undefined {
  const { metrics, protocol, metricExport } = req.config;
  if (metrics !== "otlp" && metrics !== "console") return undefined;
  return build("metric reader", () => {
    const inner = metrics === "console" ? new ConsoleMetricExporter() : otlpMetricExporter(protocol.metrics);
    // PeriodicExportingMetricReader refuses a timeout above the interval; sdk-node clamps it.
    const exportIntervalMillis = metricExport.intervalMillis;
    const exportTimeoutMillis = Math.min(metricExport.timeoutMillis, exportIntervalMillis);
    return new PeriodicExportingMetricReader({
      exporter: exemplarMetricExporter(inner, req.exemplars),
      exportIntervalMillis,
      exportTimeoutMillis,
    });
  });
}

/** Builds the exporters for every signal the configuration routes to "otlp" or "console". */
export function buildExporters(req: ExporterRequest): ExporterSet {
  const spans = spanExporter(req);
  const reader = metricReader(req);
  const logs = logExporter(req);
  return {
    ...(spans === undefined ? {} : { spanExporter: spans }),
    ...(reader === undefined ? {} : { metricReader: reader }),
    ...(logs === undefined ? {} : { logExporter: logs }),
  };
}
