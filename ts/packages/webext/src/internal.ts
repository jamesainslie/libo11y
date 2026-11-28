/**
 * @libo11y/webext/internal: the seams @libo11y/rum composes. For libo11y packages only.
 * It follows the package version and carries no compatibility promise.
 */

export type {
  ChromeLike,
  ExtensionEvent,
  MessageSenderLike,
  RuntimeMessageListener,
  StorageChangeLike,
} from "./chrome.ts";
export { type ContentDeps, defaultContentDeps, setupContentScriptWith, WORKER_ENDPOINT } from "./content.ts";
export type {
  ContentScriptSetupOptions,
  ContentScriptTelemetry,
  TracedMessageListener,
  TracedMessaging,
  WorkerSetupOptions,
  WorkerTelemetry,
} from "./options.ts";
export { defaultWorkerDeps, setupWorkerWith, type WorkerDeps } from "./worker.ts";
