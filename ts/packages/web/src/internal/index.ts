/**
 * @libo11y/web/internal: the building blocks @libo11y/webext and @libo11y/rum compose. For
 * libo11y packages only. It follows the package version and carries no compatibility promise.
 */

export { activeConsent, setActiveConsent } from "../consent/active.ts";
export { createConsentController } from "../consent/controller.ts";
export { privacySignalDenies } from "../consent/privacy-signals.ts";
export type {
  Consent,
  ConsentController,
  ConsentControllerOptions,
  ConsentOptions,
  ConsentState,
  PrivacySignalSource,
} from "../contracts/consent.ts";
export { OTLP_SIGNALS, type OtlpBatch, type OtlpSignal } from "../contracts/otlp.ts";
export type {
  NewQueueEntry,
  PersistentQueue,
  QueueEntry,
  QueueOptions,
  QueueSize,
} from "../contracts/queue.ts";
export type {
  Delivery,
  DeliveryOptions,
  DeliveryOutcome,
  DeliveryResult,
  DeliveryShutdownOptions,
  DeliveryShutdownReport,
  SendMode,
  SendRequest,
  SendResult,
  Transport,
} from "../contracts/transport.ts";
export { installFetchInstrumentation, instrumentFetch } from "../instrumentation/fetch.ts";
export { isIgnored, shouldPropagate } from "../instrumentation/origins.ts";
export { remoteParentFromTraceparent } from "../instrumentation/server-timing.ts";
export { installFlushOnHide, type VisibilitySource } from "../lifecycle.ts";
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
} from "../options.ts";
export { browserEnv, type WebPlatformOptions, webPlatform } from "../platform.ts";
export { createMemoryQueue } from "../queue/memory.ts";
export { openQueue } from "../queue/open.ts";
export {
  type BrowserResourceOptions,
  detectBrowserResource,
  type NavigatorLike,
  parseResourceAttributes,
} from "../resource.ts";
export { defaultSetupDeps, type SetupDeps, setupWithDeps } from "../setup.ts";
export { shutdownWithin } from "../shutdown.ts";
export { createDelivery } from "../transport/delivery.ts";
export { resolveEndpoints, type SignalEndpoints } from "../transport/endpoints.ts";
export {
  createExporterSet,
  createLogExporter,
  createMetricExporter,
  createSpanExporter,
  type ExporterOptions,
} from "../transport/exporters.ts";
export { createHttpTransport, type HttpTransportOptions, UNLOAD_BODY_LIMIT } from "../transport/http.ts";
export { pristineFetch, pristineSendBeacon } from "../transport/pristine.ts";
export { serializeLogs, serializeMetrics, serializeSpans } from "../transport/serialize.ts";
