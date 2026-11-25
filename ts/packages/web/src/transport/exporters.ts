/**
 * WP1 (transport). The SDK exporters over a Delivery, and the ExporterSet a platform builds.
 */
import { type ExporterRequest, type ExporterSet, exemplarMetricExporter, O11yError } from "@libo11y/core";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import {
  ConsoleLogRecordExporter,
  type LogRecordExporter,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  ConsoleMetricExporter,
  type IMetricReader,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { ConsoleSpanExporter, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace";
import { OTLP_SIGNALS, type OtlpSignal } from "../contracts/otlp.ts";
import type { Delivery, DeliveryResult, SendMode } from "../contracts/transport.ts";
import type { SignalEndpoints } from "./endpoints.ts";
import { UNLOAD_BODY_LIMIT } from "./http.ts";
import { serializeLogs, serializeMetrics, serializeSpans } from "./serialize.ts";

/** Options the exporters share. */
export interface ExporterOptions {
  /**
   * The mode the next attempt will use, so an export that would be sent in "unload" mode is split
   * into bodies of at most UNLOAD_BODY_LIMIT uncompressed bytes (halving the item list until each
   * part fits; a single item that does not fit is still delivered alone, and queues). Default
   * () => "normal", which never splits.
   */
  readonly mode?: () => SendMode;
}

const encoder = new TextEncoder();
const SHUT_DOWN = (): ExportResult => ({
  code: ExportResultCode.FAILED,
  error: new Error("libo11y: the exporter is shut down"),
});

// bodies serializes items, halving the list until every body fits limit or holds one item.
function bodies<T>(items: readonly T[], serialize: (items: readonly T[]) => string, limit: number): string[] {
  const body = serialize(items);
  if (items.length <= 1 || encoder.encode(body).byteLength <= limit) return [body];
  const mid = Math.ceil(items.length / 2);
  return [...bodies(items.slice(0, mid), serialize, limit), ...bodies(items.slice(mid), serialize, limit)];
}

function toExportResult(results: readonly DeliveryResult[]): ExportResult {
  const failed = results.find((r) => r.outcome === "dropped" && r.error !== undefined);
  return failed?.error === undefined
    ? { code: ExportResultCode.SUCCESS }
    : { code: ExportResultCode.FAILED, error: failed.error };
}

// deliveryExporter is the export, forceFlush and shutdown every signal shares: each export
// serializes its items (split in unload mode), delivers every body at once, and reports once.
function deliveryExporter<T>(
  delivery: Delivery,
  signal: OtlpSignal,
  serialize: (items: readonly T[]) => string,
  mode: () => SendMode,
): {
  export(items: readonly T[], cb: (r: ExportResult) => void): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
} {
  const split = (items: readonly T[]): string[] =>
    mode() === "unload" ? bodies(items, serialize, UNLOAD_BODY_LIMIT) : [serialize(items)];
  const pending = new Set<Promise<void>>();
  let stopped = false;
  const forceFlush = async (): Promise<void> => {
    while (pending.size > 0) await Promise.all([...pending]);
  };
  return {
    export(items, resultCallback) {
      if (stopped) {
        resultCallback(SHUT_DOWN());
        return;
      }
      const run = (async () => {
        let result: ExportResult;
        try {
          const results = await Promise.all(split(items).map((body) => delivery.deliver({ signal, body })));
          result = toExportResult(results);
        } catch (err) {
          result = {
            code: ExportResultCode.FAILED,
            error: err instanceof Error ? err : new Error(String(err)),
          };
        }
        resultCallback(result);
      })();
      const tracked: Promise<void> = run.finally(() => {
        pending.delete(tracked);
      });
      pending.add(tracked);
    },
    forceFlush,
    async shutdown() {
      stopped = true;
      await forceFlush();
    },
  };
}

const NORMAL = (): SendMode => "normal";

/**
 * A SpanExporter that serializes each export to OTLP JSON and delivers it. The result callback
 * gets SUCCESS for "sent", "queued" and a gate drop, FAILED with the error for any other drop.
 * forceFlush resolves once every pending delivery settled; shutdown also stops accepting exports.
 */
export function createSpanExporter(delivery: Delivery, opts?: ExporterOptions): SpanExporter {
  return deliveryExporter<ReadableSpan>(delivery, "traces", serializeSpans, opts?.mode ?? NORMAL);
}

/** The LogRecordExporter counterpart of createSpanExporter. */
export function createLogExporter(delivery: Delivery, opts?: ExporterOptions): LogRecordExporter {
  return deliveryExporter<ReadableLogRecord>(delivery, "logs", serializeLogs, opts?.mode ?? NORMAL);
}

/** The PushMetricExporter counterpart, cumulative temporality, never split. */
export function createMetricExporter(delivery: Delivery): PushMetricExporter {
  const inner = deliveryExporter<ResourceMetrics>(
    delivery,
    "metrics",
    (items) => serializeMetrics(items[0] as ResourceMetrics),
    NORMAL,
  );
  return {
    export: (metrics, resultCallback) => inner.export([metrics], resultCallback),
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
    selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
  };
}

type ExporterKind = "span exporter" | "metric reader" | "log exporter";

// build runs a constructor and reports a failure as Go's "o11y: building <kind>: %w", as the
// server does.
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

function checkProtocols(req: ExporterRequest): void {
  for (const signal of OTLP_SIGNALS) {
    const protocol = req.config.protocol[signal];
    if (req.config[signal] === "otlp" && protocol !== "http/json") {
      throw new O11yError(
        "UNSUPPORTED_PROTOCOL",
        `o11y: unsupported OTLP protocol ${JSON.stringify(protocol)} for ${signal}: browsers export http/json only`,
      );
    }
  }
}

/**
 * The ExporterSet for core: for each signal routed to "otlp" with an endpoint, the exporter over
 * delivery; "console" routes get upstream's console exporters, as on the server. The metric
 * exporter is wrapped with exemplarMetricExporter(exporter, req.exemplars) in a
 * PeriodicExportingMetricReader with req.config.metricExport (timeout clamped to the interval).
 * Throws O11yError UNSUPPORTED_PROTOCOL when a signal routed to "otlp" asks for http/protobuf.
 */
export function createExporterSet(
  req: ExporterRequest,
  delivery: Delivery,
  endpoints: SignalEndpoints,
  opts?: ExporterOptions,
): ExporterSet {
  checkProtocols(req);
  const { traces, metrics, logs, metricExport } = req.config;
  const exporterOpts: ExporterOptions = opts ?? {};

  let spanExporter: SpanExporter | undefined;
  if (traces === "console") spanExporter = build("span exporter", () => new ConsoleSpanExporter());
  else if (traces === "otlp" && endpoints.traces !== undefined) {
    spanExporter = build("span exporter", () => createSpanExporter(delivery, exporterOpts));
  }

  let logExporter: LogRecordExporter | undefined;
  if (logs === "console") logExporter = build("log exporter", () => new ConsoleLogRecordExporter());
  else if (logs === "otlp" && endpoints.logs !== undefined) {
    logExporter = build("log exporter", () => createLogExporter(delivery, exporterOpts));
  }

  let metricReader: IMetricReader | undefined;
  const metricInner =
    metrics === "console"
      ? (): PushMetricExporter => new ConsoleMetricExporter()
      : metrics === "otlp" && endpoints.metrics !== undefined
        ? (): PushMetricExporter => createMetricExporter(delivery)
        : undefined;
  if (metricInner !== undefined) {
    metricReader = build("metric reader", () => {
      // PeriodicExportingMetricReader refuses a timeout above the interval; sdk-node clamps it.
      const exportIntervalMillis = metricExport.intervalMillis;
      const exportTimeoutMillis = Math.min(metricExport.timeoutMillis, exportIntervalMillis);
      return new PeriodicExportingMetricReader({
        exporter: exemplarMetricExporter(metricInner(), req.exemplars),
        exportIntervalMillis,
        exportTimeoutMillis,
      });
    });
  }

  return {
    ...(spanExporter === undefined ? {} : { spanExporter }),
    ...(metricReader === undefined ? {} : { metricReader }),
    ...(logExporter === undefined ? {} : { logExporter }),
  };
}
