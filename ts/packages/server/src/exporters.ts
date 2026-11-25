/**
 * The exporters for each signal core routes to otlp or console.
 *
 * An OTLP exporter is upstream's in everything but the transport. It is upstream's OTLPExporterBase
 * (OTLPMetricExporterBase for metrics) over upstream's export delegate, configured as upstream's own
 * exporter classes configure it: convertLegacyHttpOptions with no options, so upstream reads its
 * OTEL_EXPORTER_OTLP_* variables (endpoint, headers, timeout, compression, certificates), and
 * upstream's serializers and exporter metrics. The transport is libo11y's (otlp-transport.ts),
 * because upstream's cannot be stopped: shutdown() ends what is still in flight, so an exporter
 * never keeps an exiting process alive.
 *
 * The metric exporter takes libo11y's serializers, which write exemplars: protobuf from this
 * package, JSON from core. Both metric routes wrap the exporter with exemplarMetricExporter, so
 * each collection carries the exemplar store's samples.
 */
import {
  type ExporterRequest,
  type ExporterSet,
  exemplarMetricExporter,
  O11yError,
  OtlpJsonMetricsSerializer,
} from "@libo11y/core";
import { OTLPMetricExporterBase } from "@opentelemetry/exporter-metrics-otlp-http";
import {
  createOtlpNetworkExportDelegate,
  type IOtlpExportDelegate,
  OTLPExporterBase,
} from "@opentelemetry/otlp-exporter-base";
import {
  convertLegacyHttpOptions,
  createOtlpHttpExporterMetrics,
} from "@opentelemetry/otlp-exporter-base/node-http";
import {
  type IExporterMetricsHelper,
  type ISerializer,
  JsonLogsSerializer,
  JsonTraceSerializer,
  LogsExporterMetricsHelper,
  MetricsExporterMetricsHelper,
  ProtobufLogsSerializer,
  ProtobufTraceSerializer,
  TraceExporterMetricsHelper,
} from "@opentelemetry/otlp-transformer";
import {
  ConsoleLogRecordExporter,
  type LogRecordExporter,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  ConsoleMetricExporter,
  type IMetricReader,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { ConsoleSpanExporter, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace";
import { OtlpProtobufMetricsSerializer } from "./otlp-proto-metrics.ts";
import { type AbortableTransport, createHttpTransport } from "./otlp-transport.ts";

/** The otel.component.type upstream's OTLP HTTP exporters report. */
const SPAN_EXPORTER_COMPONENT = "otlp_http_span_exporter";
const METRIC_EXPORTER_COMPONENT = "otlp_http_metric_exporter";
const LOG_EXPORTER_COMPONENT = "otlp_http_log_exporter";

const PROTOBUF = "application/x-protobuf";
const JSON_TYPE = "application/json";

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

/** One signal's OTLP export: upstream's delegate over a transport that can be stopped. */
interface OtlpExport<Internal> {
  readonly delegate: IOtlpExportDelegate<Internal>;
  readonly transport: AbortableTransport;
}

/**
 * Builds the export delegate for a signal as upstream's exporter classes do: the options from
 * convertLegacyHttpOptions, so the shared and the signal's own OTEL_EXPORTER_OTLP_* variables apply,
 * upstream's bounded export queue and exporter metrics, and libo11y's transport.
 */
function otlpExport<Internal, Response>(
  signal: "TRACES" | "METRICS" | "LOGS",
  path: string,
  contentType: string,
  serializer: ISerializer<Internal, Response>,
  component: string,
  metricsHelper: IExporterMetricsHelper<Internal>,
): OtlpExport<Internal> {
  const options = convertLegacyHttpOptions({}, signal, path, { "Content-Type": contentType });
  const transport = createHttpTransport(options);
  const delegate = createOtlpNetworkExportDelegate(
    options,
    serializer,
    createOtlpHttpExporterMetrics(component, metricsHelper, options.url, undefined),
    transport,
  );
  return { delegate, transport };
}

// stop ends an exporter. Upstream's shutdown waits for the exports in flight, which is what keeps
// an exiting process alive when the collector does not answer. This one ends them first: whoever
// stops an exporter has flushed it, or has run out of time to.
async function stop(transport: AbortableTransport, shutdown: () => Promise<void>): Promise<void> {
  transport.abort();
  await shutdown();
}

/** Upstream's OTLP exporter for spans or log records, over a transport that shutdown() stops. */
class OtlpExporter<Internal> extends OTLPExporterBase<Internal> {
  private readonly transport: AbortableTransport;

  constructor(otlp: OtlpExport<Internal>) {
    super(otlp.delegate);
    this.transport = otlp.transport;
  }

  override shutdown(): Promise<void> {
    return stop(this.transport, () => super.shutdown());
  }
}

/**
 * Upstream's OTLP metric exporter base, which takes the temporality preference from
 * OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE, over a transport that shutdown() stops.
 */
class OtlpMetricExporter extends OTLPMetricExporterBase {
  private readonly transport: AbortableTransport;

  constructor(otlp: OtlpExport<ResourceMetrics>) {
    super(otlp.delegate);
    this.transport = otlp.transport;
  }

  override shutdown(): Promise<void> {
    return stop(this.transport, () => super.shutdown());
  }
}

/** The OTLP metric exporter for protocol, with libo11y's serializer, which writes exemplars. */
function otlpMetricExporter(protocol: string): PushMetricExporter {
  const protobuf = protocol === "http/protobuf";
  return new OtlpMetricExporter(
    otlpExport(
      "METRICS",
      "v1/metrics",
      protobuf ? PROTOBUF : JSON_TYPE,
      protobuf ? OtlpProtobufMetricsSerializer : OtlpJsonMetricsSerializer,
      METRIC_EXPORTER_COMPONENT,
      MetricsExporterMetricsHelper,
    ),
  );
}

function spanExporter(req: ExporterRequest): SpanExporter | undefined {
  const { traces, protocol } = req.config;
  if (traces === "console") return new ConsoleSpanExporter();
  if (traces !== "otlp") return undefined;
  return build("span exporter", () => {
    const json = protocol.traces === "http/json";
    return new OtlpExporter<ReadableSpan[]>(
      otlpExport(
        "TRACES",
        "v1/traces",
        json ? JSON_TYPE : PROTOBUF,
        json ? JsonTraceSerializer : ProtobufTraceSerializer,
        SPAN_EXPORTER_COMPONENT,
        TraceExporterMetricsHelper,
      ),
    );
  });
}

function logExporter(req: ExporterRequest): LogRecordExporter | undefined {
  const { logs, protocol } = req.config;
  if (logs === "console") return new ConsoleLogRecordExporter();
  if (logs !== "otlp") return undefined;
  return build("log exporter", () => {
    const json = protocol.logs === "http/json";
    return new OtlpExporter<ReadableLogRecord[]>(
      otlpExport(
        "LOGS",
        "v1/logs",
        json ? JSON_TYPE : PROTOBUF,
        json ? JsonLogsSerializer : ProtobufLogsSerializer,
        LOG_EXPORTER_COMPONENT,
        LogsExporterMetricsHelper,
      ),
    );
  });
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
