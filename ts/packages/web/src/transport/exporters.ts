/**
 * WP1 (transport). The SDK exporters over a Delivery, and the ExporterSet a platform builds.
 */
import type { ExporterRequest, ExporterSet } from "@libo11y/core";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { SpanExporter } from "@opentelemetry/sdk-trace";
import type { Delivery, SendMode } from "../contracts/transport.ts";
import type { SignalEndpoints } from "./endpoints.ts";

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

/**
 * A SpanExporter that serializes each export to OTLP JSON and delivers it. The result callback
 * gets SUCCESS for "sent", "queued" and a gate drop, FAILED with the error for any other drop.
 * forceFlush resolves once every pending delivery settled; shutdown also stops accepting exports.
 */
export function createSpanExporter(delivery: Delivery, opts?: ExporterOptions): SpanExporter {
  void delivery;
  void opts;
  throw new Error("not implemented");
}

/** The LogRecordExporter counterpart of createSpanExporter. */
export function createLogExporter(delivery: Delivery, opts?: ExporterOptions): LogRecordExporter {
  void delivery;
  void opts;
  throw new Error("not implemented");
}

/** The PushMetricExporter counterpart, cumulative temporality, never split. */
export function createMetricExporter(delivery: Delivery): PushMetricExporter {
  void delivery;
  throw new Error("not implemented");
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
  void req;
  void delivery;
  void endpoints;
  void opts;
  throw new Error("not implemented");
}
