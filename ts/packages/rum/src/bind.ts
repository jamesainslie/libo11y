/**
 * Platform bindings (R3f). setupRumWith builds the RUM core, then hands a binding the setup options
 * with RUM's span processor, context manager and forwarding span exporter in place, and the
 * wrappers below. The binding runs its platform's setup with them: web's setupWithDeps for pages,
 * @libo11y/webext's setupContentScriptWith for extension pages and content scripts.
 */
import type { ExporterSet } from "@libo11y/core";
import type { WebSetupOptions, WebTelemetry } from "@libo11y/web";
import {
  type ConsentController,
  type HttpTransportOptions,
  type SetupDeps,
  setupWithDeps,
  type WebPlatformOptions,
} from "@libo11y/web/internal";
import type { RequestStartHook } from "./contracts/runtime.ts";

/** What the RUM core hands a platform binding, to wrap the parts of the platform's setup RUM needs. */
export interface RumWrappers {
  /** Takes the consent controller the platform built; RUM's gate. Returns the controller to use. */
  readonly consentController: (c: ConsentController) => ConsentController;
  /** Takes the platform options before core builds anything, for RUM's span exporter and retention flush. */
  readonly platform: (opts: WebPlatformOptions) => void;
  /** Routes the platform's exporter set by session. Build it with delta metric temporality, as the gateway needs. */
  readonly exporterSet: (set: ExporterSet) => ExporterSet;
  /** RUM's hook, for the fetch and XHR instrumentation's onStart. */
  readonly onRequestStart: RequestStartHook;
  /** Adds the gateway wire parameters to an HTTP transport, for a binding that sends over HTTP. */
  readonly transportOptions: (o: HttpTransportOptions) => HttpTransportOptions;
}

/** Runs a platform's setup with RUM's wrappers. */
export type RumBind = (options: WebSetupOptions, wrappers: RumWrappers) => Promise<WebTelemetry>;

/** The web binding: setupWithDeps over deps with RUM's wrappers, installing globally when install is true. */
export function webBinding(deps: SetupDeps, install: boolean): RumBind {
  return (options, w) =>
    setupWithDeps(
      options,
      {
        ...deps,
        createConsentController: (o) => w.consentController(deps.createConsentController(o)),
        createHttpTransport: (o) => deps.createHttpTransport(w.transportOptions(o)),
        onPlatform: (platform, po) => {
          w.platform(po);
          deps.onPlatform?.(platform, po);
        },
        // Traces are injected, so web builds no span exporter here; logs are routed by session. The
        // gateway accepts only delta sums and histograms, so app metrics export with delta temporality.
        createExporterSet: (req, d, endpoints, eo) =>
          w.exporterSet(deps.createExporterSet(req, d, endpoints, { ...eo, metricTemporality: "delta" })),
        installFetchInstrumentation: (o) =>
          deps.installFetchInstrumentation({ ...o, onStart: w.onRequestStart }),
        installXhrInstrumentation: (o) => deps.installXhrInstrumentation({ ...o, onStart: w.onRequestStart }),
      },
      install,
    );
}
