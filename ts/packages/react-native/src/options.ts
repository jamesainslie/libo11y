/**
 * The public options of @libo11y/react-native and its telemetry handle.
 */
import type { Telemetry, TelemetryOptions } from "@libo11y/core";
import type { Consent, ConsentState, UrlMatcher } from "@libo11y/web";
import type { ContextManager } from "@opentelemetry/api";
import type { KeyValueStorage } from "./contracts/storage.ts";

/**
 * Consent on React Native: an initial state, and no browser privacy signals, because a React
 * Native runtime has none.
 */
export interface ReactNativeConsentOptions {
  /** Default "pending": nothing is recorded, stored or sent until consent.grant(). */
  readonly initial?: ConsentState;
}

/**
 * How the OTLP/HTTP transport sends and retries. Every batch is saved in the retry queue before it
 * is sent, so a batch exported just before the app is suspended or stopped goes out on the next
 * launch.
 */
export interface ReactNativeTransportOptions {
  /** The most bytes the retry queue holds; the oldest batches go first. Default 2097152 (2 MiB). */
  readonly maxQueueBytes?: number;
  /** The most batches the retry queue holds. Default 500. */
  readonly maxQueueEntries?: number;
  /** Queued batches older than this are dropped. Default 86400000 (24 hours). */
  readonly maxQueueAgeMillis?: number;
  /** The timeout of one request. Default 10000. */
  readonly timeoutMillis?: number;
  /** The first retry delay, doubled per attempt with full jitter. Default 1000. */
  readonly initialBackoffMillis?: number;
  /** The largest retry delay. Default 300000. */
  readonly maxBackoffMillis?: number;
}

/**
 * Which requests get client spans.
 */
export interface ReactNativeInstrumentationOptions {
  /** Patch the global fetch. Default true. */
  readonly fetch?: boolean;
  /** Patch the global XMLHttpRequest. Default true. */
  readonly xhr?: boolean;
  /**
   * The origins that receive traceparent, tracestate and baggage, such as
   * "https://api.example.com". Default none, because an app has no origin of its own.
   */
  readonly propagateTo?: readonly UrlMatcher[];
  /** URLs that get no span. The OTLP endpoints never do. */
  readonly ignoreUrls?: readonly UrlMatcher[];
}

/**
 * The options of setupReactNative: core's TelemetryOptions plus where and how to export.
 */
export interface ReactNativeSetupOptions extends TelemetryOptions {
  /**
   * The OTLP/HTTP base URL, absolute, such as "https://app.example.com/_o11y". Signals post to
   * `<endpoint>/v1/traces`, `/v1/metrics` and `/v1/logs`. An app has no page to resolve a relative
   * URL against, so every endpoint must be an absolute http or https URL.
   */
  readonly endpoint?: string;
  /** The full traces URL, used as is. Beats endpoint. */
  readonly tracesEndpoint?: string;
  /** The full metrics URL, used as is. Beats endpoint. */
  readonly metricsEndpoint?: string;
  /** The full logs URL, used as is. Beats endpoint. */
  readonly logsEndpoint?: string;
  /** Headers for every export request. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * OTEL_* variables, read as the server reads process.env, because an app has no process
   * environment. Options beat them. Ignored when hermetic is true. Default: none.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** The consent the telemetry starts with. */
  readonly consent?: ReactNativeConsentOptions;
  /**
   * Where the retry queue lives. Default memoryStorage(), which is lost when the app stops.
   * AsyncStorage satisfies KeyValueStorage as it is.
   */
  readonly storage?: KeyValueStorage;
  /** How batches are sent, queued and retried. */
  readonly transport?: ReactNativeTransportOptions;
  /** Which requests get client spans, and which origins receive trace context. */
  readonly instrumentations?: ReactNativeInstrumentationOptions;
  /**
   * The context manager. Default upstream's StackContextManager, which carries context through
   * synchronous code only, not across await.
   */
  readonly contextManager?: () => ContextManager;
  /**
   * Random bytes for IDs, such as expo-crypto's getRandomValues. Default crypto.getRandomValues
   * where the runtime has it, else Math.random. These IDs are not secrets.
   */
  readonly getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/**
 * The handle setupReactNative resolves with: core's Telemetry with the consent and traceFetch.
 */
export interface ReactNativeTelemetry extends Telemetry {
  /** The application's handle on consent: grant, revoke, state and subscribe. */
  readonly consent: Consent;
  /**
   * Wraps a fetch the global patch does not reach, such as expo/fetch imported directly, so its
   * requests get spans and traceparent like the global fetch's. A fetch wrapped already, the
   * patched global fetch included, is returned unchanged. Without the global install
   * (setupReactNative installs it), fetchImpl is returned as it is.
   */
  traceFetch<F extends typeof fetch>(fetchImpl: F): F;
}
