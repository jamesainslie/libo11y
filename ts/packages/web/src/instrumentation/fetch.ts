/**
 * WP4 (instrumentation). Client spans for fetch.
 */
import { type Attributes, context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
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

/**
 * Wraps fetchImpl (default globalThis.fetch as it is now) with a CLIENT span per request, as the
 * server's instrumentFetch does (name, attributes, http.client.request.duration with the span's
 * exemplar, status handling, never mutating the caller's Request or init). Differences: traceparent,
 * tracestate and baggage are injected only when shouldPropagate(url, opts.propagateTo) is true; an
 * ignored URL, a URL that is not http: or https: (data:, blob:, ...) or a closed consent
 * (state() !== "granted") gets no span and no injection; a Request from another realm, such as an
 * iframe, is read as a Request; onStart is called after the span starts.
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

  const traced = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = asRequest(input);
    const url = requestUrl(request?.url ?? (input as string | URL), pageHref());
    if (url === undefined || !isHttpUrl(url) || isIgnored(url, ignoreUrls)) return base(input, init);
    const { tracer, histogram, propagator, consent } = instruments();
    if (!consentAllows(consent)) return base(input, init);

    const start = performance.now();
    const raw = sentMethod(init?.method ?? request?.method ?? "GET");
    const { method } = normalizeMethod(raw);
    const server = serverAttributes(url);
    const attributes: Attributes = { ...methodAttributes(raw), ...urlAttributes(url) };
    const parent = context.active();
    const span = tracer.startSpan(spanName(raw), { kind: SpanKind.CLIENT, attributes }, parent);
    const spanContext = trace.setSpan(parent, span);
    callOnStart(opts.onStart, span, { kind: "fetch", url, method: raw });

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
      if (shouldPropagate(url, propagateTo)) {
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
