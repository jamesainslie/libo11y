/**
 * Contract, frozen by the L4 scaffold. Changing it needs the architect's sign-off, because WP1, WP3,
 * WP4 and WP5 all read it, and it is the public API.
 *
 * The public options of @libo11y/web and the WebTelemetry handle.
 */
import type { Telemetry, TelemetryOptions } from "@libo11y/core";
import type { ContextManager, Span } from "@opentelemetry/api";
import type { Consent, ConsentOptions } from "./contracts/consent.ts";

/** How the OTLP/HTTP JSON transport sends and retries. */
export interface TransportOptions {
  /** gzip request bodies through CompressionStream where the browser has it. Default "gzip". */
  readonly compression?: "gzip" | "none";
  /**
   * Keep batches that failed with a retryable error in an IndexedDB queue and retry them with
   * backoff, in this page and in later pages of the origin. Default true. false drops them.
   */
  readonly offlineQueue?: boolean;
  /** The IndexedDB database name. Default "libo11y". */
  readonly databaseName?: string;
  /** The most bytes the queue holds; the oldest batches go first. Default 5 MiB. */
  readonly maxQueueBytes?: number;
  /** Queued batches older than this are dropped. Default 24 hours. */
  readonly maxQueueAgeMillis?: number;
  /** The first retry delay, doubled per attempt with full jitter. Default 1000. */
  readonly initialBackoffMillis?: number;
  /** The largest retry delay. Default 300000. */
  readonly maxBackoffMillis?: number;
  /** The timeout of one request. Default 10000. */
  readonly timeoutMillis?: number;
}

/**
 * Where and how telemetry is exported. Browsers have no environment, so the OTLP endpoint is an
 * option. A signal is exported when it has an endpoint from these options or from env; otherwise
 * it is off. The protocol is always http/json.
 */
export interface BrowserExportOptions {
  /**
   * The OTLP/HTTP base URL. Signals post to `<endpoint>/v1/traces`, `/v1/metrics` and `/v1/logs`.
   * A relative URL resolves against the page. A cross-origin collector must answer CORS preflights
   * for POST with Content-Type and Content-Encoding.
   */
  readonly endpoint?: string;
  /** The full traces URL, used as is. Beats endpoint. */
  readonly tracesEndpoint?: string;
  /** The full metrics URL, used as is. Beats endpoint. */
  readonly metricsEndpoint?: string;
  /** The full logs URL, used as is. Beats endpoint. */
  readonly logsEndpoint?: string;
  /**
   * Headers for every export request. sendBeacon cannot send headers, so with headers set an
   * unload-time batch goes by fetch keepalive only.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * OTEL_* variables, read as the server reads process.env: OTEL_SERVICE_NAME,
   * OTEL_RESOURCE_ATTRIBUTES, OTEL_TRACES_SAMPLER, OTEL_BSP_*, OTEL_EXPORTER_OTLP_*_ENDPOINT and so
   * on. Options beat them. Ignored when hermetic is true. Default: none.
   */
  readonly env?: Readonly<Record<string, string>>;
  readonly transport?: TransportOptions;
  /**
   * Record user_agent.original on the resource. Default false, because the full user-agent string
   * helps fingerprint a user. It still passes through the sensitivity policy.
   */
  readonly userAgent?: boolean;
}

/** An origin that may receive trace context: an exact origin such as "https://api.example.com", or a RegExp tested against the origin. */
export type OriginMatcher = string | RegExp;

/** A URL to leave uninstrumented: a string prefix of the absolute URL, or a RegExp tested against it. */
export type UrlMatcher = string | RegExp;

/** The request an HTTP client span describes, for onStart. */
export interface HttpRequestInfo {
  readonly kind: "fetch" | "xhr";
  /** The absolute request URL. */
  readonly url: URL;
  /** The method as sent. */
  readonly method: string;
}

/** Options for the fetch and XHR instrumentation. */
export interface HttpInstrumentationOptions {
  /**
   * The telemetry whose providers, propagator and consent to use. Without it, the globals setup
   * installed and the consent of the telemetry setup returned.
   */
  readonly telemetry?: Telemetry;
  /**
   * Cross-origin destinations that receive traceparent, tracestate and baggage. The page's own
   * origin always does; every other origin gets nothing unless it matches. Default [].
   */
  readonly propagateTo?: readonly OriginMatcher[];
  /** URLs that get no span and no injected context. The OTLP endpoints are always ignored. */
  readonly ignoreUrls?: readonly UrlMatcher[];
  /**
   * Called with each client span right after it starts, before the request is sent, so a
   * framework layer (the L5 RUM packages) can rename it or add attributes. A throw is reported
   * through diag and ignored.
   */
  readonly onStart?: (span: Span, request: HttpRequestInfo) => void;
}

/** Options for recordDocumentLoad. */
export interface DocumentLoadOptions {
  /** The telemetry whose tracer provider and consent to use. Without it, the globals. */
  readonly telemetry?: Telemetry;
  /** Abandons a span not yet recorded, as shutdown does. */
  readonly signal?: AbortSignal;
}

/** What setup instruments. Every instrumentation is removed again by shutdown. */
export interface WebInstrumentationOptions {
  /** Patch globalThis.fetch with client spans. Default true. */
  readonly fetch?: boolean;
  /** Patch XMLHttpRequest with client spans. Default true. */
  readonly xhr?: boolean;
  /** Record the documentLoad span, adopting Server-Timing traceparent. Default true. */
  readonly documentLoad?: boolean;
  /** As HttpInstrumentationOptions.propagateTo, for both fetch and XHR. */
  readonly propagateTo?: readonly OriginMatcher[];
  /** As HttpInstrumentationOptions.ignoreUrls, for both fetch and XHR. */
  readonly ignoreUrls?: readonly UrlMatcher[];
}

/** Options for setup and createTelemetry in a browser. */
export interface WebSetupOptions extends TelemetryOptions, BrowserExportOptions {
  /** The consent gate. Default: pending until consent.grant(). */
  readonly consent?: ConsentOptions;
  /**
   * Builds the context manager. Default createContextManager(), upstream's StackContextManager,
   * which carries context through synchronous code and context.with only. Pass a factory for
   * ZoneContextManager from `@opentelemetry/context-zone` to carry it across await and timers.
   */
  readonly contextManager?: () => ContextManager;
  /** What setup instruments. createTelemetry ignores it. */
  readonly instrumentations?: WebInstrumentationOptions;
}

/** A running browser telemetry pipeline. */
export interface WebTelemetry extends Telemetry {
  /** The consent gate. */
  readonly consent: Consent;
}
