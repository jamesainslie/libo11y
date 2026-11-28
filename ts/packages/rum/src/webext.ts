/**
 * @libo11y/rum/webext: RUM in Manifest V3 extensions. setupRumExtension for extension pages and
 * content scripts, setupRumWorker for the service worker that sends their records, and
 * allowRumSessionInContentScripts for a worker set up with @libo11y/webext's setupWorker directly.
 * The collectors come from @libo11y/rum; the types its options and handle name are re-exported here.
 */

export type {
  AddErrorOptions,
  BootstrapEntry,
  CollectorName,
  RemoteConfig,
  RemoteConfigClient,
  RemoteConfigConnection,
  RemoteConfigDocument,
  RemoteConfigOpenOptions,
  RemoteConfigTimers,
  RequestStartHook,
  Rum,
  RumBus,
  RumCollector,
  RumOptions,
  RumRuntime,
  RumScope,
  RumSettings,
  RumSignal,
  SessionDecision,
  SessionEvent,
  SessionManager,
  SessionState,
  SummaryAccumulator,
  SummaryCountKey,
  SummaryView,
  ViewEvent,
  ViewStartOptions,
  ViewState,
  ViewTracker,
  VitalName,
} from "./index.ts";
export type {
  ChromeSessionStorageLike,
  RumChromeLike,
  StorageAreaLike,
  StorageChangeListener,
  StorageChanges,
} from "./webext/chrome.ts";
export { allowRumSessionInContentScripts } from "./webext/session-store.ts";
export {
  CONTENT_VIEW_NAME,
  type RumExtensionOptions,
  type RumExtensionTelemetry,
  type RumWorkerSetupOptions,
  setupRumExtension,
  setupRumWorker,
} from "./webext/setup.ts";
