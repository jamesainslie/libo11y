/**
 * The libo11y browser platform: setup over the OpenTelemetry JS providers with a pluggable context
 * manager, the browser resource, an OTLP/HTTP JSON transport with gzip, unload-time beacons and an
 * IndexedDB retry queue, the consent gate, and fetch, XHR and document-load spans with origin-scoped
 * propagation. No RUM features: those are @libo11y/rum (L5).
 *
 * Scaffold, frozen: the public API. Changing it needs the architect's sign-off.
 */

export {
  type LifecycleOptions,
  type Logger,
  O11yError,
  type O11yErrorCode,
  type SignalReport,
  type Telemetry,
  type TelemetryOptions,
} from "@libo11y/core";
export { createContextManager } from "./context.ts";
export type { Consent, ConsentOptions, ConsentState } from "./contracts/consent.ts";
export { recordDocumentLoad } from "./instrumentation/document-load.ts";
export { installFetchInstrumentation, instrumentFetch } from "./instrumentation/fetch.ts";
export { installXhrInstrumentation } from "./instrumentation/xhr.ts";
export type {
  BrowserExportOptions,
  DocumentLoadOptions,
  HttpInstrumentationOptions,
  HttpRequestInfo,
  OriginMatcher,
  TransportOptions,
  UrlMatcher,
  WebInstrumentationOptions,
  WebSetupOptions,
  WebTelemetry,
} from "./options.ts";
export { createTelemetry, setup } from "./setup.ts";
