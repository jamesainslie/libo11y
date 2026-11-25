/**
 * WP3 (web platform and setup). The browser Platform, also used by @libo11y/webext.
 */
import type { Platform, RecordingGate } from "@libo11y/core";
import type { ContextManager } from "@opentelemetry/api";
import type { Delivery, SendMode } from "./contracts/transport.ts";
import type { BrowserExportOptions } from "./options.ts";
import type { SignalEndpoints } from "./transport/endpoints.ts";

/** Options for webPlatform. */
export interface WebPlatformOptions {
  /** Platform.name. Default "web". */
  readonly name?: "web" | "webext";
  readonly exportOptions: BrowserExportOptions;
  /** The resolved endpoints, from resolveEndpoints. */
  readonly endpoints: SignalEndpoints;
  /** The delivery the exporters use. */
  readonly delivery: Delivery;
  /** The consent gate, passed to core as Platform.gate. */
  readonly gate: RecordingGate;
  /** The send mode, for the exporters' unload splitting. Default () => "normal". */
  readonly mode?: () => SendMode;
  /** Default createContextManager. */
  readonly contextManager?: () => ContextManager;
  /** Extra OTEL_* defaults under exportOptions.env, such as the webext worker's short batch delays. */
  readonly envDefaults?: Readonly<Record<string, string>>;
}

/**
 * The OTEL_* variables the platform reports: envDefaults, then exportOptions.env, then
 * OTEL_EXPORTER_OTLP_PROTOCOL=http/json, then OTEL_<SIGNAL>_EXPORTER=none for each signal whose
 * endpoint is undefined unless env names an exporter for it.
 */
export function browserEnv(
  exportOptions: BrowserExportOptions,
  endpoints: SignalEndpoints,
  envDefaults?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  void exportOptions;
  void endpoints;
  void envDefaults;
  throw new Error("not implemented");
}

/**
 * A browser Platform: env from browserEnv, detectBrowserResource, the context manager,
 * createExporterSet over the delivery, console lines through the console methods captured when the
 * platform is built (so captureConsole cannot recurse), SHA-1 by crypto.subtle, UUIDs by
 * crypto.randomUUID with a getRandomValues fallback outside secure contexts, the global console for
 * captureConsole, and gate. No runtime metrics.
 */
export function webPlatform(opts: WebPlatformOptions): Platform {
  void opts;
  throw new Error("not implemented");
}
