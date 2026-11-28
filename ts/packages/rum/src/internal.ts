/**
 * @libo11y/rum/internal: what the RUM adapter packages and the browser fixtures compose. For
 * libo11y packages only. It follows the package version, carries no compatibility promise and has
 * no API report.
 */
export { actionName, actionTarget, elementSelector } from "./actions/naming.ts";
export { ATTR_SESSION_ID, ATTR_USER_ID, summaryCountKey, summaryVitalKey } from "./attrs.ts";
export {
  afterLoadOn,
  BOOTSTRAP_KEY,
  bootstrapBuffer,
  installRumBootstrapOn,
  takeBootstrap,
} from "./bootstrap/buffer.ts";
export { replayBootstrap } from "./bootstrap/replay.ts";
export { createBus } from "./bus.ts";
export { clampConfig, parseRemoteConfig, resolveLimits } from "./config/clamp.ts";
export { CONFIG_STORAGE_KEY, createRemoteConfig } from "./config/remote.ts";
export type { RetentionBuffer, RetentionRouting } from "./contracts/retention.ts";
export type { SessionStore } from "./contracts/session.ts";
export { randomUuid } from "./ids.ts";
export { stripQuery } from "./query.ts";
export { createRetentionBuffer, RETENTION_QUEUE_DEFAULTS } from "./retention/buffer.ts";
export { retainingLogExporter, retainingSpanExporter, withRetention } from "./retention/exporters.ts";
export {
  type BroadcastChannelLike,
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
