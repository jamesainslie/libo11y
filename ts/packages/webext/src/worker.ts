/**
 * WP5 (webext). setupWorker for a Manifest V3 service worker.
 */
import type { WorkerSetupOptions, WorkerTelemetry } from "./options.ts";

/** OTEL_* defaults for the worker, under the caller's env: short delays, because the worker can stop at any time. */
export const WORKER_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  OTEL_BSP_SCHEDULE_DELAY: "1000",
  OTEL_BLRP_SCHEDULE_DELAY: "1000",
  OTEL_METRIC_EXPORT_INTERVAL: "15000",
};

/**
 * Builds and installs the worker's telemetry. Call it at the top level of the worker script on
 * every wake. In order: the consent controller with the stored state beating options.consent
 * (readStoredConsent) and syncConsent; openQueue (IndexedDB at the extension origin); the HTTP
 * transport with sendBeacon undefined; a delivery with persistFirst true and mode always "normal";
 * webPlatform with name "webext" and WORKER_ENV_DEFAULTS; setupWith; serviceVersion defaulting to
 * the manifest version. Then: the runtime.onMessage listener for ExportMessages from this
 * extension's own contexts (sender.id === runtime.id), which puts each accepted batch in the queue,
 * replies, and drains; the worker's fetch instrumentation; and a drain of whatever the last wake
 * left. Rejects like setup on a bad configuration.
 */
export function setupWorker(options: WorkerSetupOptions = {}): Promise<WorkerTelemetry> {
  void options;
  throw new Error("not implemented");
}
