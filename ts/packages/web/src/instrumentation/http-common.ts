/**
 * WP4 (instrumentation). What the fetch and XHR spans share: method normalization (as the server's
 * http-common.ts, copied because @libo11y/server is not browser-safe), URL attributes, the duration
 * histogram, the Headers and XHR carriers, and resolving the tracer, meter, propagator and consent.
 */
import type { Telemetry } from "@libo11y/core";
import type { Attributes, Histogram, TextMapPropagator, TextMapSetter, Tracer } from "@opentelemetry/api";
import type { Consent } from "../contracts/consent.ts";

/** The instrumentation scope of the browser HTTP and document-load spans. */
export const SCOPE = "@libo11y/web";

/** The tracer, histogram, propagator and consent one request uses. */
export interface HttpInstruments {
  readonly tracer: Tracer;
  /** http.client.request.duration in seconds, with the stable semconv buckets. */
  readonly histogram: Histogram;
  readonly propagator: TextMapPropagator;
  /** The consent to honour, or undefined when there is none (record as the providers allow). */
  readonly consent: Consent | undefined;
}

/**
 * Returns a resolver of the instruments for each request: from telemetry when given (its consent
 * when it is a WebTelemetry), else the global providers, the global propagator and activeConsent().
 * Globals are looked up per request and the instruments rebuilt only when a provider changes, as on
 * the server.
 */
export function instrumentResolver(telemetry: Telemetry | undefined): () => HttpInstruments {
  void telemetry;
  throw new Error("not implemented");
}

/** http.request.method (and http.request.method_original when normalization changed it). */
export function methodAttributes(raw: string): Attributes {
  void raw;
  throw new Error("not implemented");
}

/** The span name for a method: the normalized method, or "HTTP" for an unknown one. */
export function spanName(raw: string): string {
  void raw;
  throw new Error("not implemented");
}

/** server.address, server.port and url.full (credentials removed) of a request URL. */
export function urlAttributes(url: URL): Attributes {
  void url;
  throw new Error("not implemented");
}

/** Writes a Headers carrier for injection. */
export const HEADERS_SETTER: TextMapSetter<Headers> = {
  set: (carrier, key, value) => carrier.set(key, value),
};
