/**
 * @libo11y/rum/internal: what the RUM adapter packages and the browser fixtures compose. For
 * libo11y packages only. It follows the package version and carries no compatibility promise.
 */
export { actionName, actionTarget, type CssEscape, elementSelector } from "./actions/naming.ts";
export { ATTR_SESSION_ID, ATTR_USER_ID, summaryCountKey, summaryVitalKey } from "./attrs.ts";
export {
  afterLoadOn,
  BOOTSTRAP_KEY,
  type BootstrapBuffer,
  type BootstrapClock,
  type BootstrapEntry,
  bootstrapBuffer,
  installRumBootstrapOn,
  type LoadHost,
  type RumBootstrapOptions,
  takeBootstrap,
} from "./bootstrap/buffer.ts";
export { replayBootstrap } from "./bootstrap/replay.ts";
export { createBus } from "./bus.ts";
export {
  clampConfig,
  parseRemoteConfig,
  type RemoteConfigDocument,
  type RemoteConfigLimits,
  type ResolvedLimits,
  resolveLimits,
} from "./config/clamp.ts";
export {
  CONFIG_STORAGE_KEY,
  createRemoteConfig,
  type RemoteConfig,
  type RemoteConfigClient,
  type RemoteConfigClientOptions,
  type RemoteConfigConnection,
  type RemoteConfigOpenOptions,
  type RemoteConfigOptions,
  type RemoteConfigTimers,
} from "./config/remote.ts";
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
export type { ConfigCacheStorage, RumCoreDeps } from "./core-setup.ts";
export { randomUuid } from "./ids.ts";
export type { AddErrorOptions, Rum, RumOptions, RumSetupOptions, RumTelemetry } from "./options.ts";
export type { PendingSpans } from "./pending-spans.ts";
export { stripQuery } from "./query.ts";
export {
  createRetentionBuffer,
  RETENTION_QUEUE_DEFAULTS,
  type RetentionBufferOptions,
} from "./retention/buffer.ts";
export { retainingLogExporter, retainingSpanExporter, withRetention } from "./retention/exporters.ts";
export {
  type BroadcastChannelLike,
  type LocalSessionStoreOptions,
  localStorageSessionStore,
  parseSessionState,
  SESSION_CHANNEL,
  SESSION_STORAGE_KEY,
} from "./session/local-store.ts";
export { createSessionManager, type SessionManagerOptions } from "./session/manager.ts";
export { fnv1a32, sessionSampled } from "./session/sampling.ts";
export { type ResolvedRum, resolveSettings } from "./settings.ts";
export { defaultRumDeps, type RumDeps, runtimeOf, setupRumWith } from "./setup.ts";
export { APP_LOAD_SPAN, type RumSpanProcessorOptions, rumSpanProcessor } from "./span-processor.ts";
export { createSummaryAccumulator, type SummaryOptions } from "./summary/accumulator.ts";
export { defaultViewName } from "./views/naming.ts";
export { createViewTracker, type ViewTrackerOptions } from "./views/tracker.ts";
export { gatewayTransportOptions, withWireParams } from "./wire.ts";
