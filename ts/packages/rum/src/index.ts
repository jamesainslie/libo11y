/**
 * libo11y RUM for browsers: setupRum over @libo11y/web, and the collectors it runs.
 */
export type * from "./contracts/runtime.ts";
export type {
  SessionDecision,
  SessionEvent,
  SessionManager,
  SessionState,
} from "./contracts/session.ts";
export type { SummaryAccumulator, SummaryCountKey, SummaryView, VitalName } from "./contracts/summary.ts";
export type { ViewEvent, ViewStartOptions, ViewState, ViewTracker } from "./contracts/views.ts";
export type { HttpRequestInfo, Rum, RumOptions, RumSetupOptions, RumTelemetry } from "./options.ts";
export { setupRum } from "./setup.ts";
export { VERSION } from "./version.ts";
