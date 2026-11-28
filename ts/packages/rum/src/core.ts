/**
 * @libo11y/rum/core: the RUM core without the web, for a platform binding that is not a page, such
 * as React Native's. setupRumCore runs RUM over a binding (contracts/binding.ts); the building
 * blocks it composes are here for the binding's own collectors and stores. Nothing reachable from
 * here imports a browser-only module or reads a browser global at module evaluation (core.test.ts
 * enforces both), so a bundler that does not tree-shake, such as Metro, pulls in nothing a phone
 * cannot run. For libo11y packages only: it follows the package version, carries no compatibility
 * promise and has no API report.
 */

export { actionSpanName, actionSpanStart, recordInstantAction } from "./actions/record.ts";
export {
  createSettleTracker,
  type SettleOptions,
  type SettleTimers,
  type SettleTracker,
} from "./actions/settle.ts";
export { ATTR_SESSION_ID, ATTR_USER_ID, summaryCountKey, summaryVitalKey } from "./attrs.ts";
export { createBus } from "./bus.ts";
export {
  clampConfig,
  parseRemoteConfig,
  type RemoteConfigDocument,
  resolveLimits,
} from "./config/clamp.ts";
export {
  CONFIG_STORAGE_KEY,
  createRemoteConfig,
  type RemoteConfig,
  type RemoteConfigConnection,
  remoteConfig,
} from "./config/remote.ts";
export { rumContextManager } from "./context-manager.ts";
export type {
  RumBind,
  RumLifecycle,
  RumLifecycleHandlers,
  RumPlatformInfo,
  RumPlatformOptions,
  RumWrappers,
} from "./contracts/binding.ts";
export type { RetentionBuffer, RetentionRouting } from "./contracts/retention.ts";
export type {
  CollectorName,
  EventBody,
  RequestStartHook,
  RumBus,
  RumCollector,
  RumRuntime,
  RumScope,
  RumSettings,
  RumSignal,
} from "./contracts/runtime.ts";
export type {
  SessionDecision,
  SessionEvent,
  SessionManager,
  SessionState,
  SessionStore,
} from "./contracts/session.ts";
export type { SummaryAccumulator, SummaryCountKey, SummaryView, VitalName } from "./contracts/summary.ts";
export type { ViewEvent, ViewStartOptions, ViewState, ViewTracker } from "./contracts/views.ts";
export {
  type ConfigCacheStorage,
  type RumCoreDeps,
  runtimeOf,
  SESSION_END_ELECTION_MILLIS,
  setupRumCore,
} from "./core-setup.ts";
export { createBreadcrumbs } from "./errors/breadcrumbs.ts";
export { normalizeError } from "./errors/normalize.ts";
export { recordError, wasRecorded } from "./errors/record.ts";
export { createFrustrationDetector } from "./frustration/detect.ts";
export { randomUuid } from "./ids.ts";
export type { AddErrorOptions, Rum, RumOptions } from "./options.ts";
export { stripQuery } from "./query.ts";
export { createRetentionBuffer, RETENTION_QUEUE_DEFAULTS } from "./retention/buffer.ts";
export { retainingLogExporter, retainingSpanExporter, withRetention } from "./retention/exporters.ts";
export { sessionsIn } from "./retention/sessions.ts";
export { createSessionManager, type SessionManagerOptions } from "./session/manager.ts";
export { fnv1a32, sessionSampled } from "./session/sampling.ts";
export { parseSessionState, SESSION_STORAGE_KEY } from "./session/state.ts";
export { type ResolvedRum, resolveSettings } from "./settings.ts";
export { APP_LOAD_SPAN, type RumSpanProcessorOptions, rumSpanProcessor } from "./span-processor.ts";
export { createSummaryAccumulator, type SummaryOptions } from "./summary/accumulator.ts";
export {
  type MutationObserverCtor,
  type MutationObserverLike,
  VIEW_SPAN_CAP_MILLIS,
  type ViewsEnv,
  type ViewsOptions,
  viewsWith,
} from "./views/collector.ts";
export { afterNextPaint, type PaintHost } from "./views/paint.ts";
export { createViewTracker, type ViewTrackerOptions } from "./views/tracker.ts";
export { gatewayTransportOptions, withWireParams } from "./wire.ts";
