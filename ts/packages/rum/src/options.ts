/** The public options and handle of setupRum. */
import type { HttpRequestInfo, WebSetupOptions, WebTelemetry } from "@libo11y/web";
import type { Span } from "@opentelemetry/api";
import type { CollectorName, RequestStartHook, RumCollector } from "./contracts/runtime.ts";

/** RUM's own options, under rum in setupRum's options. Code sets every default and limit. */
export interface RumOptions {
  /** The share of sessions whose detail is sent from the start, 0 to 1. Default 1. */
  readonly sessionSampleRate?: number;
  /** A session ends after this long without activity. Default 900000 (15 minutes). */
  readonly sessionIdleMillis?: number;
  /** A session ends this long after it started. Default 14400000 (4 hours). */
  readonly sessionMaxMillis?: number;
  /** Query parameters kept in recorded URLs. Every other parameter is removed. Default []. */
  readonly queryAllowList?: readonly string[];
  /** The collectors to run, such as [views(), actions(), errors(), vitals(), resources()]. Default []. */
  readonly collectors?: readonly RumCollector[];
  /** Names a view from its URL when no router adapter names it. Default: the path with ID-like segments as $id. */
  readonly viewName?: (url: URL) => string;
  /** Bounds of the retention buffer for sessions not yet kept. */
  readonly retention?: { readonly maxBytes?: number; readonly maxAgeMillis?: number };
  /**
   * The app's public client token for the RUM gateway. It is not a secret: it identifies the app.
   * Every OTLP request carries it as the client_token query parameter, next to sent_at, because
   * sendBeacon cannot set headers.
   */
  readonly clientToken?: string;
}

/** Options for setupRum: the setup options of `@libo11y/web` and RUM's own. */
export interface RumSetupOptions extends WebSetupOptions {
  readonly rum?: RumOptions;
}

/** The application's handle on RUM. */
export interface Rum {
  /** The current session's ID, or undefined while consent is not granted. */
  sessionId(): string | undefined;
  /**
   * Sets user.id on every later span and collector event, or clears it with undefined. View
   * summaries and session events do not carry it. Pass a pseudonymous ID that your application
   * registry classifies internal. Throws O11yError INVALID_OPTION for a value that contains an at
   * sign, because an email address is never an ID.
   */
  identify(userId: string | undefined): void;
  /** Adds a hook run on every fetch and XHR client span right after it starts. Returns its removal. */
  onRequestStart(hook: RequestStartHook): () => void;
}

/** Browser telemetry with RUM. */
export interface RumTelemetry extends WebTelemetry {
  readonly rum: Rum;
}

export type { CollectorName, HttpRequestInfo, RequestStartHook, RumCollector, Span };
