/**
 * WP4 (instrumentation). What the fetch and XHR spans share: method normalization (as the server's
 * http-common.ts, copied because @libo11y/server is not browser-safe), URL attributes, the duration
 * histogram, the Headers and XHR carriers, and resolving the tracer, meter, propagator and consent.
 */
import type { Telemetry } from "@libo11y/core";
import {
  type Attributes,
  diag,
  type Histogram,
  type MeterProvider,
  metrics,
  propagation,
  type Span,
  type TextMapPropagator,
  type TextMapSetter,
  type Tracer,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import { activeConsent } from "../consent/active.ts";
import type { Consent } from "../contracts/consent.ts";
import type { HttpInstrumentationOptions, HttpRequestInfo } from "../options.ts";
import { VERSION } from "../version.ts";

/** The instrumentation scope of the browser HTTP and document-load spans. */
export const SCOPE = "@libo11y/web";

/** The duration histogram's name, as on the server. */
export const DURATION_METRIC = "http.client.request.duration";

/** The stable HTTP semconv duration buckets, in seconds, which otelhttp and the server also use. */
export const DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

/** The tracer, histogram, propagator and consent one request uses. */
export interface HttpInstruments {
  readonly tracer: Tracer;
  /** http.client.request.duration in seconds, with the stable semconv buckets. */
  readonly histogram: Histogram;
  readonly propagator: TextMapPropagator;
  /** The consent to honour, or undefined when there is none (record as the providers allow). */
  readonly consent: Consent | undefined;
}

/** The consent of a telemetry that is a WebTelemetry, else undefined. */
export function consentOf(telemetry: Telemetry | undefined): Consent | undefined {
  const consent = (telemetry as { consent?: Partial<Consent> } | undefined)?.consent;
  return typeof consent?.state === "function" && typeof consent.subscribe === "function"
    ? (consent as Consent)
    : undefined;
}

/** Whether a request may be recorded and carry context: there is no consent, or it is granted. */
export function consentAllows(consent: Consent | undefined): boolean {
  return consent === undefined || consent.state() === "granted";
}

/**
 * Returns a resolver of the instruments for each request: from telemetry when given (its consent
 * when it is a WebTelemetry), else the global providers, the global propagator and activeConsent().
 * Globals are looked up per request and the instruments rebuilt only when a provider changes, as on
 * the server.
 */
export function instrumentResolver(telemetry: Telemetry | undefined): () => HttpInstruments {
  let cached:
    | {
        tp: TracerProvider;
        mp: MeterProvider;
        propagator: TextMapPropagator;
        consent: Consent | undefined;
        instruments: HttpInstruments;
      }
    | undefined;
  const ownConsent = consentOf(telemetry);
  return () => {
    const tp = telemetry?.tracerProvider ?? trace.getTracerProvider();
    const mp = telemetry?.meterProvider ?? metrics.getMeterProvider();
    const propagator = telemetry?.propagator ?? propagation;
    const consent = telemetry === undefined ? activeConsent() : ownConsent;
    if (cached === undefined || cached.tp !== tp || cached.mp !== mp) {
      const histogram = mp.getMeter(SCOPE, VERSION).createHistogram(DURATION_METRIC, {
        unit: "s",
        description: "Duration of HTTP client requests.",
        advice: { explicitBucketBoundaries: [...DURATION_BUCKETS] },
      });
      cached = {
        tp,
        mp,
        propagator,
        consent,
        instruments: { tracer: tp.getTracer(SCOPE, VERSION), histogram, propagator, consent },
      };
    } else if (cached.consent !== consent || cached.propagator !== propagator) {
      cached = {
        ...cached,
        propagator,
        consent,
        instruments: { ...cached.instruments, propagator, consent },
      };
    }
    return cached.instruments;
  };
}

const METHOD_OTHER = "_OTHER";

// The semantic-convention method set otelhttp keeps (methodLookup in otelhttp v0.72.0).
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
]);

/**
 * Maps a request method onto the semantic-convention set as Go's o11yhttp does: a known method
 * passes, a known method in another case is upper-cased, anything else is "_OTHER". original is set
 * when the method was not already in normalized form. An empty method is "_OTHER" with no original.
 */
export function normalizeMethod(method: string): { method: string; original?: string } {
  if (method === "") return { method: METHOD_OTHER };
  if (KNOWN_METHODS.has(method)) return { method };
  const upper = method.toUpperCase();
  if (KNOWN_METHODS.has(upper)) return { method: upper, original: method };
  return { method: METHOD_OTHER, original: method };
}

/** http.request.method (and http.request.method_original when normalization changed it). */
export function methodAttributes(raw: string): Attributes {
  const { method, original } = normalizeMethod(raw);
  return original === undefined
    ? { "http.request.method": method }
    : { "http.request.method": method, "http.request.method_original": original };
}

/** The span name for a method: the normalized method, or "HTTP" for an unknown one. */
export function spanName(raw: string): string {
  const { method } = normalizeMethod(raw);
  return method === METHOD_OTHER ? "HTTP" : method;
}

/** server.address and server.port of a URL: the host without IPv6 brackets, and the port or the scheme default. */
export function serverAttributes(url: URL): Attributes {
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { "server.address": host, "server.port": port };
}

/** server.address, server.port and url.full (credentials removed) of a request URL. */
export function urlAttributes(url: URL): Attributes {
  const full = new URL(url);
  full.username = "";
  full.password = "";
  return { ...serverAttributes(url), "url.full": full.href };
}

/** The document base URL (else the page's URL) that relative request URLs resolve against, when there is a page. */
export function pageHref(): string | undefined {
  const g = globalThis as { document?: { baseURI?: string }; location?: { href?: string } };
  return g.document?.baseURI ?? g.location?.href;
}

// The methods the Fetch and XMLHttpRequest standards upper-case whatever case they are given in.
const SENT_NORMALIZED: ReadonlySet<string> = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);

/** The method fetch and XHR send for raw: both standards upper-case six methods in any case. */
export function sentMethod(raw: string): string {
  const upper = raw.toUpperCase();
  return SENT_NORMALIZED.has(upper) ? upper : raw;
}

/** Calls onStart, reporting a throw through diag. */
export function callOnStart(
  onStart: HttpInstrumentationOptions["onStart"],
  span: Span,
  request: HttpRequestInfo,
): void {
  if (onStart === undefined) return;
  try {
    onStart(span, request);
  } catch (err) {
    diag.warn(`libo11y: ${request.kind} instrumentation: onStart threw, ignored: ${String(err)}`);
  }
}

/** The absolute URL of a request, resolved against base; undefined when it cannot be parsed. */
export function requestUrl(input: string | URL, base: string | undefined): URL | undefined {
  try {
    return new URL(input, base);
  } catch {
    return undefined;
  }
}

/** The error.type of a thrown value: its name, such as TypeError or AbortError, else "_OTHER". */
export function errorName(err: unknown): string {
  if (typeof err === "object" && err !== null && typeof (err as { name?: unknown }).name === "string") {
    return (err as { name: string }).name;
  }
  return METHOD_OTHER;
}

/** A thrown value as a span exception, for recordException. */
export function asException(err: unknown): Error | string {
  return err instanceof Error ? err : String(err);
}

/** Writes a Headers carrier for injection. */
export const HEADERS_SETTER: TextMapSetter<Headers> = {
  set: (carrier, key, value) => carrier.set(key, value),
};

/** Writes into an XMLHttpRequest before send, for injection. */
export const XHR_SETTER: TextMapSetter<XMLHttpRequest> = {
  set: (carrier, key, value) => carrier.setRequestHeader(key, value),
};
