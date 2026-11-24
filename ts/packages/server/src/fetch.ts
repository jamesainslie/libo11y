/**
 * instrumentFetch: client instrumentation for fetch, the counterpart of Go's o11yhttp.NewTransport.
 * It wraps a fetch function and returns a new one; it never patches globalThis.fetch, and it works
 * on Bun, whose fetch publishes none of the undici diagnostics channels Node's instrumentation reads.
 */
import type { Telemetry } from "@libo11y/core";
import {
  type Attributes,
  context,
  diag,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  asException,
  HEADERS_SETTER,
  instrumentResolver,
  methodAttributes,
  methodName,
  normalizeMethod,
  serverAttributes,
} from "./http-common.ts";

/** Options for {@link instrumentFetch}. */
export interface FetchOptions {
  /** The telemetry whose providers and propagator to use. Without it, the globals setup installs. */
  readonly telemetry?: Telemetry;
  /**
   * Decides per destination whether the trace context and baggage are injected. Every destination
   * gets them by default; return false for third parties that should not see internal trace IDs.
   * A predicate that throws is reported through the OpenTelemetry diag logger and taken as false.
   */
  readonly propagate?: (url: URL) => boolean;
  /** The peer.service attribute: the logical name of the service called. */
  readonly peerService?: string;
}

// The methods the Fetch standard upper-cases whatever case they are given in.
const FETCH_NORMALIZED: ReadonlySet<string> = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);

/** The method fetch sends for raw: the Fetch standard upper-cases six methods in any case. */
function sentMethod(raw: string): string {
  const upper = raw.toUpperCase();
  return FETCH_NORMALIZED.has(upper) ? upper : raw;
}

/** The error.type of a failed fetch: the error's name, such as TypeError or AbortError. */
function errorName(err: unknown): string {
  if (typeof err === "object" && err !== null && typeof (err as { name?: unknown }).name === "string") {
    return (err as { name: string }).name;
  }
  return "_OTHER";
}

/**
 * Wraps fetchImpl (default: globalThis.fetch as it is now) with a CLIENT span per request, named by
 * method, and the http.client.request.duration histogram, recorded in the span's context so its
 * exemplar carries the trace. The span ends when the response headers arrive, or when the request
 * fails. 4xx and 5xx responses and failures mark the span failed. The trace context is injected
 * into a copy of the request headers; the caller's Request and init are never changed. A URL that
 * cannot be parsed is passed to fetchImpl uninstrumented, so its own error surfaces.
 */
export function instrumentFetch(
  fetchImpl: typeof fetch = globalThis.fetch,
  opts: FetchOptions = {},
): typeof fetch {
  const base = fetchImpl;
  const instruments = instrumentResolver(
    opts.telemetry,
    "http.client.request.duration",
    "Duration of HTTP client requests.",
  );

  const traced = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    let url: URL;
    try {
      url = new URL(request?.url ?? String(input));
    } catch {
      return base(input, init);
    }
    const start = performance.now();
    const { tracer, histogram, propagator } = instruments();
    const raw = sentMethod(init?.method ?? request?.method ?? "GET");
    const { method } = normalizeMethod(raw);
    const server = serverAttributes(url);
    const full = new URL(url);
    full.username = "";
    full.password = "";
    const attributes: Attributes = {
      ...methodAttributes(raw),
      ...server,
      "url.full": full.href,
      ...(opts.peerService === undefined ? {} : { "peer.service": opts.peerService }),
    };
    const parent = context.active();
    const span = tracer.startSpan(methodName(method), { kind: SpanKind.CLIENT, attributes }, parent);
    const spanContext = trace.setSpan(parent, span);

    let propagate = true;
    try {
      propagate = opts.propagate?.(url) ?? true;
    } catch (err) {
      propagate = false;
      diag.warn(`libo11y: instrumentFetch: propagate threw, the context is not sent: ${String(err)}`);
    }

    const finish = (status: number | undefined, failure?: { error: unknown }): void => {
      const errorType =
        failure !== undefined
          ? errorName(failure.error)
          : status !== undefined && status >= 400
            ? String(status)
            : undefined;
      if (status !== undefined) span.setAttribute("http.response.status_code", status);
      if (errorType !== undefined) {
        span.setAttribute("error.type", errorType);
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      if (failure !== undefined) span.recordException(asException(failure.error));
      histogram.record(
        (performance.now() - start) / 1000,
        {
          "http.request.method": method,
          ...server,
          ...(status === undefined ? {} : { "http.response.status_code": status }),
          ...(errorType === undefined ? {} : { "error.type": errorType }),
        },
        trace.setSpan(ROOT_CONTEXT, span),
      );
      span.end();
    };

    let res: Response;
    try {
      let args: [string | URL | Request, RequestInit | undefined] = [input, init];
      if (propagate) {
        // fetch takes init's headers over the Request's, so the copy starts from the same source.
        // Headers fetch would reject throw here instead, and fail the request the same way.
        const headers = new Headers(init?.headers ?? request?.headers);
        propagator.inject(spanContext, headers, HEADERS_SETTER);
        args = [input, { ...init, headers }];
      }
      res = await context.with(spanContext, () => base(...args));
    } catch (err) {
      finish(undefined, { error: err });
      throw err;
    }
    finish(res.status);
    return res;
  };
  const preconnect = (base as { preconnect?: unknown }).preconnect;
  if (typeof preconnect === "function") Object.assign(traced, { preconnect: preconnect.bind(base) });
  return traced as typeof fetch;
}
