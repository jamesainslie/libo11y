/**
 * The libo11y Manifest V3 extension platform: setupWorker for the service worker, which persists
 * every batch to IndexedDB before sending because the worker can stop at any time, and
 * setupContentScript for content scripts and extension pages, which forward their records to the
 * worker by runtime messaging. Trace context crosses with every traced message. No RUM features.
 *
 * Scaffold, frozen: the public API. Changing it needs the architect's sign-off.
 */

export type { Consent, ConsentOptions, ConsentState, WebTelemetry } from "@libo11y/web";
export type {
  ChromeLike,
  ExtensionEvent,
  MessageSenderLike,
  RuntimeMessageListener,
  StorageChangeLike,
} from "./chrome.ts";
export { setupContentScript } from "./content.ts";
export type {
  ContentScriptSetupOptions,
  ContentScriptTelemetry,
  TracedMessageListener,
  TracedMessaging,
  WorkerSetupOptions,
  WorkerTelemetry,
} from "./options.ts";
export {
  type ExportMessage,
  type ExportReply,
  type Libo11yMessage,
  PROTOCOL_VERSION,
  type TracedMessage,
  type TracedReply,
} from "./protocol.ts";
export { setupWorker } from "./worker.ts";
