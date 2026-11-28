/**
 * WP4 (instrumentation). Client spans for fetch.
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
import { reportError } from "../background-flush.ts";
import type { HttpInstrumentationOptions } from "../options.ts";
import {
  asException,
  asRequest,
  callOnStart,
  consentAllows,
  errorName,
  HEADERS_SETTER,
  type HttpInternals,
  instrumentResolver,
  isHttpUrl,
  methodAttributes,
  normalizeMethod,
  pageHref,
  requestUrl,
  sentMethod,
  serverAttributes,
  spanName,
  urlAttributes,
} from "./http-common.ts";
import { isIgnored, shouldPropagate } from "./origins.ts";

/** What one request's telemetry needs once its span has started. */
interface Begun {
  readonly span: Span;
  /** The caller's context with the client span set. */
  readonly spanContext: Context;
  readonly histogram: Histogram;
  readonly propagator: TextMapPropagator;
  /** The method as sent, for the span name and onStart. */
  readonly raw: string;
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
 * Wraps fetchImpl (default globalThis.fetch as it is now) with a CLIENT span per request, as the
 * server's instrumentFetch does (name, attributes, http.client.request.duration with the span's
 * exemplar, status handling, never mutating the caller's Request or init). Differences: traceparent,
 * tracestate and baggage are injected only when shouldPropagate(url, opts.propagateTo) is true; an
 * ignored URL, a URL that is not http: or https: (data:, blob:, ...) or a closed consent
 * (state() !== "granted") gets no span and no injection; a Request from another realm, such as an
 * iframe, is read as a Request; onStart is called after the span starts.
 *
 * The telemetry never fails the request. A span that cannot start leaves the request
 * uninstrumented, a propagator that throws leaves it without the injected context, and a span that
 * cannot end changes nothing the caller sees. Each is reported to the telemetry's reporter, or the
 * global error handler without one. Only fetchImpl itself, or headers it would reject, make the
 * returned promise reject.
 */
export function instrumentFetch(
  fetchImpl: typeof fetch = globalThis.fetch,
  opts: HttpInstrumentationOptions = {},
): typeof fetch {
  return instrumentFetchWith(fetchImpl, opts);
}

/**
 * instrumentFetch with the scope a platform other than the browser sets. Internal. skip is the
 * XHR patch's alone: a platform that nests fetch calls handles that in its own wrapper.
 */
export function instrumentFetchWith(
  base: typeof fetch,
  opts: HttpInstrumentationOptions,
  internals?: Pick<HttpInternals, "scope">,
): typeof fetch {
  const instruments = instrumentResolver(opts.telemetry, internals?.scope);
  const propagateTo = opts.propagateTo ?? [];
  const ignoreUrls = opts.ignoreUrls ?? [];

  // begin resolves the instruments, checks consent and starts the client span. It returns undefined
  // when consent is closed. Whatever it throws comes from the telemetry, never from the request.
  const begin = (url: URL, rawMethod: string): Begun | undefined => {
    const { tracer, histogram, propagator, consent } = instruments();
    if (!consentAllows(consent)) return undefined;
    const raw = sentMethod(rawMethod);
    const { method } = normalizeMethod(raw);
    const server = serverAttributes(url);
    const attributes: Attributes = { ...methodAttributes(raw), ...urlAttributes(url) };
    const parent = context.active();
    const span = tracer.startSpan(spanName(raw), { kind: SpanKind.CLIENT, attributes }, parent);
    return { span, spanContext: trace.setSpan(parent, span), histogram, propagator, raw, method, server };
  };

  const traced = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = asRequest(input);
    const url = requestUrl(request?.url ?? (input as string | URL), pageHref());
    if (url === undefined || !isHttpUrl(url) || isIgnored(url, ignoreUrls)) return base(input, init);

    const start = performance.now();
    let begun: Begun | undefined;
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
    if (begun === undefined) return base(input, init);
    const { span, spanContext, histogram, propagator, raw, method, server } = begun;
    callOnStart(opts.onStart, span, { kind: "fetch", url, method: raw });

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

    let args: [string | URL | Request, RequestInit | undefined] = [input, init];
    if (shouldPropagate(url, propagateTo)) {
      // fetch takes init's headers over the Request's, so the copy starts from the same source.
      let headers: Headers | undefined;
      try {
        headers = new Headers(init?.headers ?? request?.headers);
      } catch {
        // The caller's headers are ones fetch rejects. The request goes out with the caller's own
        // arguments, so fetch fails it exactly as it would fail it uninstrumented.
      }
      // A copy the propagator only half filled is not sent: the request keeps its own headers.
      if (headers !== undefined && inject(opts.telemetry, propagator, spanContext, headers)) {
        args = [input, { ...init, headers }];
      }
    }
    let res: Response;
    try {
      res = await context.with(spanContext, () => base(...args));
    } catch (err) {
      finish(undefined, { error: err });
      throw err;
    }
    finish(res);
    return res;
  };
  return traced as typeof fetch;
}

/** The instrumented fetch installFetchInstrumentation put on globalThis, while it is installed. */
let installed: typeof fetch | undefined;

/**
 * Replaces globalThis.fetch with instrumentFetch(globalThis.fetch, opts). Returns a function that
 * restores the previous fetch if globalThis.fetch is still the instrumented one; either way the
 * instrumented one passes every later call straight to the previous fetch, so a wrapper another
 * library put over it records nothing more. Installing twice without uninstalling is a no-op that
 * returns a no-op.
 */
export function installFetchInstrumentation(opts: HttpInstrumentationOptions = {}): () => void {
  if (installed !== undefined || typeof globalThis.fetch !== "function") return () => {};
  const previous = globalThis.fetch;
  const traced = instrumentFetch(previous, opts);
  let done = false;
  const patched = ((input: string | URL | Request, init?: RequestInit) =>
    done ? previous(input, init) : traced(input, init)) as typeof fetch;
  installed = patched;
  globalThis.fetch = patched;
  return () => {
    if (done) return;
    done = true;
    if (globalThis.fetch === patched) globalThis.fetch = previous;
    if (installed === patched) installed = undefined;
  };
}
