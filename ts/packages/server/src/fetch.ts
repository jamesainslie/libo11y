/**
 * instrumentFetch: client instrumentation for fetch, the counterpart of Go's o11yhttp.NewTransport.
 * It wraps a fetch function and returns a new one; it never patches globalThis.fetch, and it works
 * on Bun, whose fetch publishes none of the undici diagnostics channels Node's instrumentation reads.
 */
import type { Telemetry } from "@libo11y/core";
import {
  type Attributes,
  type Context,
  context,
  type Histogram,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TextMapPropagator,
  trace,
} from "@opentelemetry/api";
import {
  asException,
  HEADERS_SETTER,
  instrumentResolver,
  methodAttributes,
  methodName,
  normalizeMethod,
  reportError,
  serverAttributes,
} from "./http-common.ts";

/** Options for {@link instrumentFetch}. */
export interface FetchOptions {
  /** The telemetry whose providers and propagator to use. Without it, the globals setup installs. */
  readonly telemetry?: Telemetry;
  /**
   * Decides per destination whether the trace context and baggage are injected. Every destination
   * gets them by default; return false for third parties that should not see internal trace IDs.
   * A predicate that throws is taken as false and reported to the error handler by the class of
   * what it threw, never with its message, which can quote the URL.
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

/** What one request's telemetry needs once its span has started. */
interface Begun {
  readonly span: Span;
  /** The caller's context with the client span set. */
  readonly spanContext: Context;
  readonly histogram: Histogram;
  readonly propagator: TextMapPropagator;
  readonly method: string;
  readonly server: Attributes;
}

/** Injects ctx into headers. A propagator that throws is reported, and false is returned. */
function inject(
  telemetry: Telemetry | undefined,
  propagator: TextMapPropagator,
  ctx: Context,
  headers: Headers,
): boolean {
  try {
    propagator.inject(ctx, headers, HEADERS_SETTER);
    return true;
  } catch (err) {
    reportError(
      telemetry,
      "instrumentFetch: injecting the trace context failed, the request is sent without it",
      err,
    );
    return false;
  }
}

/**
 * Wraps fetchImpl (default: globalThis.fetch as it is now) with a CLIENT span per request, named by
 * method, and the http.client.request.duration histogram, recorded in the span's context so its
 * exemplar carries the trace. The span ends when the response headers arrive, or when the request
 * fails. 4xx and 5xx responses and failures mark the span failed. The trace context is injected
 * into a copy of the request headers; the caller's Request and init are never changed. A URL that
 * cannot be parsed is passed to fetchImpl uninstrumented, so its own error surfaces.
 *
 * The telemetry never fails the request. A span that cannot start leaves the request
 * uninstrumented, a propagator that throws leaves it without the injected context, and a span that
 * cannot end changes nothing the caller sees. Each is reported to the error handler. Only fetchImpl
 * itself, or headers it would reject, make the returned promise reject.
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

  // begin resolves the instruments and starts the client span. Whatever it throws comes from the
  // telemetry, never from the request.
  const begin = (url: URL, rawMethod: string): Begun => {
    const { tracer, histogram, propagator } = instruments();
    const raw = sentMethod(rawMethod);
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
    return { span, spanContext: trace.setSpan(parent, span), histogram, propagator, method, server };
  };

  const traced = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    let url: URL;
    try {
      url = new URL(request?.url ?? String(input));
    } catch {
      return base(input, init);
    }
    const start = performance.now();
    let begun: Begun;
    try {
      begun = begin(url, init?.method ?? request?.method ?? "GET");
    } catch (err) {
      reportError(
        opts.telemetry,
        "instrumentFetch: starting the request's telemetry failed, the request is not instrumented",
        err,
      );
      return base(input, init);
    }
    const { span, spanContext, histogram, propagator, method, server } = begun;

    let propagate = true;
    try {
      propagate = opts.propagate?.(url) ?? true;
    } catch (err) {
      propagate = false;
      // By class only: the predicate is handed the URL, and its error can quote it.
      reportError(
        opts.telemetry,
        "instrumentFetch: the propagate option failed, the context is not sent",
        err,
      );
    }

    const end = (response: Response | undefined, failure?: { error: unknown }): void => {
      // The status is read here, inside finish's guard: a fetchImpl may resolve with something
      // that is not a Response, and that is the caller's to deal with, not a reason to throw.
      const read = (response as { status?: unknown } | undefined)?.status;
      const status = typeof read === "number" ? read : undefined;
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
    // finish guards end, so a throw from a span processor or an instrument never replaces the
    // response or fetch's own error.
    const finish = (response: Response | undefined, failure?: { error: unknown }): void => {
      try {
        end(response, failure);
      } catch (err) {
        reportError(opts.telemetry, "instrumentFetch: ending the request's telemetry failed", err);
      }
    };

    let res: Response;
    try {
      let args: [string | URL | Request, RequestInit | undefined] = [input, init];
      if (propagate) {
        // fetch takes init's headers over the Request's, so the copy starts from the same source.
        // Headers fetch would reject throw here instead, and fail the request the same way.
        const headers = new Headers(init?.headers ?? request?.headers);
        // A copy the propagator only half filled is not sent: the request keeps its own headers.
        if (inject(opts.telemetry, propagator, spanContext, headers)) args = [input, { ...init, headers }];
      }
      res = await context.with(spanContext, () => base(...args));
    } catch (err) {
      finish(undefined, { error: err });
      throw err;
    }
    finish(res);
    return res;
  };
  const preconnect = (base as { preconnect?: unknown }).preconnect;
  if (typeof preconnect === "function") Object.assign(traced, { preconnect: preconnect.bind(base) });
  return traced as typeof fetch;
}
