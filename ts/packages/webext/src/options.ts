/**
 * The public options and handles of @libo11y/webext.
 */
import type {
  BrowserExportOptions,
  ConsentOptions,
  HttpInstrumentationOptions,
  TelemetryOptions,
  WebInstrumentationOptions,
  WebTelemetry,
} from "@libo11y/web";
import type { ContextManager } from "@opentelemetry/api";
import type { MessageSenderLike } from "./chrome.ts";

/**
 * Handles a traced message. It runs inside the sender's trace context, so spans it starts are
 * children of the sender's active span. The returned value (or resolved value) is the reply.
 */
export type TracedMessageListener = (payload: unknown, sender: MessageSenderLike) => unknown;

/** Traced runtime messaging, on both sides. */
export interface TracedMessaging {
  /**
   * Adds a runtime.onMessage listener for traced messages; other messages are left to other
   * listeners. Returns a function that removes it.
   */
  onMessage(listener: TracedMessageListener): () => void;
  /**
   * runtime.sendMessage(payload) wrapped in a TracedMessage with the active context. Resolves with
   * the listener's result; rejects with its error, or when no listener answered.
   */
  sendMessage<R = unknown>(payload: unknown): Promise<R>;
}

/** Options for setupWorker. */
export interface WorkerSetupOptions extends TelemetryOptions, BrowserExportOptions {
  /**
   * The consent gate's initial state and privacy signals. The state is persisted in
   * chrome.storage.local under "libo11y.consent", and a stored state beats initial, because the
   * worker restarts at any time.
   */
  readonly consent?: ConsentOptions;
  /** Default createContextManager() from `@libo11y/web`. */
  readonly contextManager?: () => ContextManager;
  /** Client spans for the worker's own fetch calls. Default true. */
  readonly fetch?: boolean | Pick<HttpInstrumentationOptions, "propagateTo" | "ignoreUrls">;
  /** Accept export batches from content scripts and extension pages. Default true. */
  readonly acceptForwarded?: boolean;
}

/** The service worker's telemetry. */
export interface WorkerTelemetry extends WebTelemetry, TracedMessaging {
  /** tabs.sendMessage(tabId, payload) as a TracedMessage. Rejects where tabs is unavailable. */
  sendTabMessage<R = unknown>(tabId: number, payload: unknown): Promise<R>;
}

/** Options for setupContentScript. */
export interface ContentScriptSetupOptions extends TelemetryOptions {
  /** OTEL_* variables, as BrowserExportOptions.env. */
  readonly env?: Readonly<Record<string, string>>;
  /** Default createContextManager() from `@libo11y/web`. */
  readonly contextManager?: () => ContextManager;
  /**
   * What to instrument in this context. fetch and xhr default true and see only the content
   * script's own requests (content scripts run in an isolated world). documentLoad defaults to
   * false in a content script, whose document is the page's, and true in an extension page.
   */
  readonly instrumentations?: WebInstrumentationOptions;
  /** As BrowserExportOptions.userAgent. */
  readonly userAgent?: boolean;
}

/**
 * A content script's or extension page's telemetry. Its records go to the worker by runtime
 * messaging. Its consent mirrors the worker's through chrome.storage.local; grant and revoke here
 * change it for the whole extension.
 */
export interface ContentScriptTelemetry extends WebTelemetry, TracedMessaging {}
