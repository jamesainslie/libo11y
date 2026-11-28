/**
 * What instrumentServe and instrumentFetch share: the semantic-convention method set and its
 * normalization (Go o11yhttp's normalizeMethod), the duration histograms, the Headers carrier, URL
 * attributes, resolving the tracer, meter and propagator from a Telemetry or the globals, and
 * reporting a failure of the instrumentation itself.
 */
import type { Telemetry } from "@libo11y/core";
import {
  type Attributes,
  type Histogram,
  type MeterProvider,
  metrics,
  propagation,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  type Tracer,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import { globalErrorHandler } from "@opentelemetry/core";
import { VERSION } from "./version.ts";

/** The instrumentation scope of the HTTP spans and metrics. */
export const SCOPE = "@libo11y/server";

/** The stable HTTP semconv duration buckets, in seconds, which otelhttp also uses. */
export const DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

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
 * when http.request.method_original must be recorded: the method was not already in normalized
 * form. An empty method is "_OTHER" with no original.
 */
export function normalizeMethod(method: string): { method: string; original?: string } {
  if (method === "") return { method: METHOD_OTHER };
  if (KNOWN_METHODS.has(method)) return { method };
  const upper = method.toUpperCase();
  if (KNOWN_METHODS.has(upper)) return { method: upper, original: method };
  return { method: METHOD_OTHER, original: method };
}

/** The span name for a normalized method: semconv names spans of unknown methods "HTTP". */
export function methodName(method: string): string {
  return method === METHOD_OTHER ? "HTTP" : method;
}

/** The method and, when normalization changed it, the original, as span attributes. */
export function methodAttributes(raw: string): Attributes {
  const { method, original } = normalizeMethod(raw);
  return original === undefined
    ? { "http.request.method": method }
    : { "http.request.method": method, "http.request.method_original": original };
}

/** server.address and server.port of a URL: the host without IPv6 brackets, and the port or the scheme default. */
export function serverAttributes(url: URL): Attributes {
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { "server.address": host, "server.port": port };
}

// The query keys whose values semconv says url.full SHOULD redact by default (presigned URLs). The
// same set and matching as redactQuery in @libo11y/web's http-common.ts, which mirrors this file.
const REDACTED_QUERY_KEYS: ReadonlySet<string> = new Set([
  "AWSAccessKeyId",
  "Signature",
  "sig",
  "X-Goog-Signature",
]);

/** search with the value of each REDACTED_QUERY_KEYS parameter replaced by REDACTED, the rest as is. */
function redactQuery(search: string): string {
  if (search.length <= 1) return search;
  const parts = search.slice(1).split("&");
  let changed = false;
  for (const [i, part] of parts.entries()) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    let key: string;
    try {
      key = decodeURIComponent(part.slice(0, eq).replaceAll("+", " "));
    } catch {
      // A key that is not valid percent-encoding is none of the redacted keys.
      continue;
    }
    if (REDACTED_QUERY_KEYS.has(key)) {
      parts[i] = `${part.slice(0, eq)}=REDACTED`;
      changed = true;
    }
  }
  return changed ? `?${parts.join("&")}` : search;
}

/**
 * The url.full of a request URL: credentials removed, and the values of the presigned-URL query
 * keys semconv names (AWSAccessKeyId, Signature, sig, X-Goog-Signature) replaced by REDACTED.
 */
export function urlFull(url: URL): string {
  const full = new URL(url);
  full.username = "";
  full.password = "";
  const search = redactQuery(full.search);
  if (search !== full.search) full.search = search;
  return full.href;
}

/** The URL scheme without its colon. */
export function schemeOf(url: URL): string {
  return url.protocol.slice(0, -1);
}

/** The error.type of a thrown value: its constructor name for an Error, else "_OTHER". */
export function errorConstructorName(err: unknown): string {
  return err instanceof Error ? err.constructor.name : METHOD_OTHER;
}

/** The message of a thrown value. It never throws, whatever was thrown. */
export function errorMessage(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return "unknown error";
  }
}

const CLASS_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

/**
 * The class of a thrown value, for a report: its constructor's name when that reads as a class
 * name, "Error" for any other error, and the value's type for anything that is not an object. It
 * never throws and never returns the value's own text.
 */
export function errorClass(thrown: unknown): string {
  try {
    if (thrown === null) return "null";
    if (typeof thrown !== "object") return typeof thrown;
    const name: unknown = (thrown as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === "string" && CLASS_NAME.test(name)) return name;
    return thrown instanceof Error ? "Error" : "object";
  } catch {
    return "unknown";
  }
}

/**
 * The key under which a telemetry handle from @libo11y/core carries its reporter: a function that
 * writes one error through the handle's own rate-limited handler. A registered symbol, so it is
 * found without importing core's internals, and on a handle made by another copy of core.
 */
const REPORT_KEY = Symbol.for("libo11y.report");

/**
 * Reports a failure of the instrumentation itself, which must never reach the request it wraps:
 * a propagator that throws, a span that cannot start or end. It never throws.
 *
 * The report is an Error whose message is "o11y: <what>: <class of what was thrown>", with what
 * was thrown on its cause. The message of what was thrown is left out: a propagator is handed the
 * request's headers, and its error can quote them.
 *
 * With a telemetry the report goes through that handle's own handler, so it is written for a
 * createTelemetry handle too, which installs nothing globally. Without one, or with something that
 * is not a core handle, it goes to the OpenTelemetry global error handler, which setup makes
 * libo11y's rate-limited one.
 */
export function reportError(telemetry: Telemetry | undefined, what: string, err: unknown): void {
  const report = new Error(`o11y: ${what}: ${errorClass(err)}`, { cause: err });
  try {
    const own: unknown = (telemetry as { [REPORT_KEY]?: unknown } | undefined)?.[REPORT_KEY];
    if (typeof own === "function") {
      own.call(telemetry, report);
      return;
    }
  } catch {
    // A handle whose reporter fails leaves the global handler.
  }
  globalErrorHandler(report);
}

/** A thrown value as a span exception, for recordException. */
export function asException(err: unknown): Error | string {
  return err instanceof Error ? err : String(err);
}

/** Reads a Headers carrier for extraction. */
export const HEADERS_GETTER: TextMapGetter<Headers> = {
  get: (carrier, key) => carrier.get(key) ?? undefined,
  keys: (carrier) => [...carrier.keys()],
};

/** Writes a Headers carrier for injection. */
export const HEADERS_SETTER: TextMapSetter<Headers> = {
  set: (carrier, key, value) => carrier.set(key, value),
};

/** The tracer, the duration histogram and the propagator one request uses. */
export interface HttpInstruments {
  readonly tracer: Tracer;
  readonly histogram: Histogram;
  readonly propagator: TextMapPropagator;
}

/**
 * Returns a function that resolves the instruments for each request: from telemetry when given,
 * else from the global providers and propagator. The global ones are looked up per request, so
 * telemetry installed by setup after the wrapper was built, or again after a shutdown, is used;
 * the instruments are rebuilt only when a provider changes.
 */
export function instrumentResolver(
  telemetry: Telemetry | undefined,
  histogramName: string,
  description: string,
): () => HttpInstruments {
  let cached: { tp: TracerProvider; mp: MeterProvider; instruments: HttpInstruments } | undefined;
  return () => {
    const tp = telemetry?.tracerProvider ?? trace.getTracerProvider();
    const mp = telemetry?.meterProvider ?? metrics.getMeterProvider();
    if (cached === undefined || cached.tp !== tp || cached.mp !== mp) {
      const histogram = mp.getMeter(SCOPE, VERSION).createHistogram(histogramName, {
        unit: "s",
        description,
        advice: { explicitBucketBoundaries: [...DURATION_BUCKETS] },
      });
      cached = {
        tp,
        mp,
        instruments: {
          tracer: tp.getTracer(SCOPE, VERSION),
          histogram,
          propagator: telemetry?.propagator ?? propagation,
        },
      };
    }
    return cached.instruments;
  };
}
