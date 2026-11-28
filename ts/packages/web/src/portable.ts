/**
 * @libo11y/web/portable: the platform-neutral building blocks of the browser platform, for
 * @libo11y/rum/core and the React Native platform. Nothing reachable from here imports a
 * browser-only module or reads a browser global at module evaluation (portable.test.ts enforces
 * both), so a bundler that does not tree-shake, such as Metro, pulls in nothing a phone cannot run.
 * For libo11y packages only: it follows the package version, carries no compatibility promise and
 * has no API report.
 */

export { activeConsent, setActiveConsent } from "./consent/active.ts";
export { createConsentController } from "./consent/controller.ts";
export { privacySignalDenies } from "./consent/privacy-signals.ts";
export { createContextManager } from "./context.ts";
export type {
  Consent,
  ConsentController,
  ConsentControllerOptions,
  ConsentOptions,
  ConsentState,
  PrivacySignalSource,
} from "./contracts/consent.ts";
export { OTLP_SIGNALS, type OtlpBatch, type OtlpSignal } from "./contracts/otlp.ts";
export type {
  NewQueueEntry,
  PersistentQueue,
  QueueEntry,
  QueueOptions,
  QueueSize,
} from "./contracts/queue.ts";
export type {
  Delivery,
  DeliveryOptions,
  DeliveryOutcome,
  DeliveryResult,
  SendMode,
  SendRequest,
  SendResult,
  Transport,
} from "./contracts/transport.ts";
export { randomBytes, randomUuid, type UuidCrypto } from "./ids.ts";
export {
  installFetchInstrumentation,
  instrumentFetch,
} from "./instrumentation/fetch.ts";
export { isIgnored, shouldPropagate } from "./instrumentation/origins.ts";
export { remoteParentFromTraceparent } from "./instrumentation/server-timing.ts";
export { installXhrInstrumentation } from "./instrumentation/xhr.ts";
export type {
  BrowserExportOptions,
  HttpInstrumentationOptions,
  HttpRequestInfo,
  OriginMatcher,
  TransportOptions,
  UrlMatcher,
} from "./options.ts";
export {
  type Bounds,
  buildEntry,
  byAge,
  DEFAULT_MAX_AGE_MILLIS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  dueAt,
  evictionPlan,
  isDue,
  isExpired,
  newEntryId,
  resolveBounds,
  utf8Length,
} from "./queue/bounds.ts";
export { createMemoryQueue } from "./queue/memory.ts";
export { createDelivery } from "./transport/delivery.ts";
export { resolveEndpoints, type SignalEndpoints } from "./transport/endpoints.ts";
export { browserEnv } from "./transport/env.ts";
export {
  createExporterSet,
  createLogExporter,
  createMetricExporter,
  createSpanExporter,
  type ExporterOptions,
} from "./transport/exporters.ts";
export { createHttpTransport, type HttpTransportOptions, UNLOAD_BODY_LIMIT } from "./transport/http.ts";
export { pristineFetch, pristineSendBeacon } from "./transport/pristine.ts";
export { serializeLogs, serializeMetrics, serializeSpans } from "./transport/serialize.ts";
