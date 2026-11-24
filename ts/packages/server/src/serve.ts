/**
 * instrumentServe: server instrumentation for fetch-style handlers, `(Request) => Response`, as
 * Bun.serve, Hono, Elysia and node:http adapters use. It is the counterpart of Go's
 * o11yhttp.NewHandler: a SERVER span named "<METHOD> <route>", http.server.request.duration with
 * exemplars, and optionally the o11y.request.summary canonical line.
 *
 * The span, the duration and the summary end when the response body finishes, errors or is
 * cancelled, from a body wrapper that holds the span itself. Nothing at the end reads the active
 * context, because Bun 1.3 loses it inside an async generator body after its first await
 * (oven-sh/bun#24199).
 */
import { type LogAttributes, startRecord, type Telemetry, type WideRecord } from "@libo11y/core";
import {
  ATTR_DURATION,
  ATTR_OUTCOME,
  EVENT_REQUEST_SUMMARY,
  OUTCOME_VALUE_FAILURE,
  OUTCOME_VALUE_SUCCESS,
} from "@libo11y/spec";
import {
  type Attributes,
  type Context,
  context,
  isSpanContextValid,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  type SpanOptions,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { matchesAny } from "./glob.ts";
import {
  asException,
  errorConstructorName,
  HEADERS_GETTER,
  instrumentResolver,
  methodName,
  normalizeMethod,
  schemeOf,
  serverAttributes,
} from "./http-common.ts";

/** Options for {@link instrumentServe}. */
export interface ServeOptions {
  /** The telemetry whose providers and propagator to use. Without it, the globals setup installs. */
  readonly telemetry?: Telemetry;
  /**
   * Resolves the route template of a request, such as "/projects/:id", for the span name,
   * http.route and the metric. A template that starts with a method and a space ("GET /x") names
   * the span verbatim, as a Go ServeMux pattern does. Without a route the span is named by method.
   */
  readonly route?: (req: Request) => string | undefined;
  /**
   * An internet-facing server: inbound trace context starts a new root span linked to it instead
   * of becoming its parent, so untrusted callers cannot graft onto internal traces. Baggage is
   * still extracted.
   */
  readonly publicEndpoint?: boolean;
  /**
   * URL paths to leave uninstrumented, as Go path.Match patterns ("/healthz", "/debug/*"). A
   * matching request gets no span, metric or summary. A malformed pattern never matches.
   */
  readonly ignorePaths?: readonly string[];
  /**
   * Adds `Server-Timing: traceparent;desc="00-<trace>-<span>-<flags>"` to text/html responses, so
   * the page can join the server's trace.
   */
  readonly serverTiming?: boolean;
  /**
   * Emits one o11y.request.summary event per request, carrying the request's wide record (see
   * currentRecord in the core package) and then the method, status, outcome, duration and route. It
   * needs telemetry; without it this option is a silent no-op, as in Go.
   */
  readonly canonicalLine?: boolean;
}

/** How a request ended, for the span, the metric and the summary. */
interface Outcome {
  readonly status: number;
  /** Set when the handler threw or the body errored, holding what was thrown. */
  readonly failure?: { readonly error: unknown };
}

/**
 * Wraps a fetch-style handler with server instrumentation. Extra handler arguments, such as
 * Bun.serve's server, pass through. The handler runs inside the server span's context, so spans and
 * logs it makes are children of it. A throw marks the span failed, records the exception and a 500,
 * and is re-thrown. A returned body is passed through a wrapper that ends the span when the body
 * finishes; that wrapper is a stream, so a body of known length is sent chunked.
 */
export function instrumentServe<A extends unknown[]>(
  handler: (req: Request, ...rest: A) => Response | Promise<Response>,
  opts: ServeOptions = {},
): (req: Request, ...rest: A) => Promise<Response> {
  const instruments = instrumentResolver(
    opts.telemetry,
    "http.server.request.duration",
    "Duration of HTTP server requests.",
  );
  const ignore = opts.ignorePaths ?? [];
  const summaryTelemetry = opts.canonicalLine === true ? opts.telemetry : undefined;

  return async (req: Request, ...rest: A): Promise<Response> => {
    const url = new URL(req.url);
    if (ignore.length > 0 && matchesAny(ignore, url.pathname)) return handler(req, ...rest);

    const start = performance.now();
    const { tracer, histogram, propagator } = instruments();
    const { method, original } = normalizeMethod(req.method);
    const resolved = opts.route?.(req);
    const route = resolved === "" ? undefined : resolved;
    const httpRoute = route === undefined ? undefined : routeOnly(route);
    const scheme = schemeOf(url);

    const extracted = propagator.extract(context.active(), req.headers, HEADERS_GETTER);
    const attributes: Attributes = {
      "http.request.method": method,
      ...(original === undefined ? {} : { "http.request.method_original": original }),
      "url.scheme": scheme,
      "url.path": url.pathname,
      ...serverAttributes(url),
    };
    const userAgent = req.headers.get("user-agent");
    if (userAgent !== null) attributes["user_agent.original"] = userAgent;
    if (httpRoute !== undefined) attributes["http.route"] = httpRoute;
    const spanOptions: SpanOptions = { kind: SpanKind.SERVER, attributes };
    if (opts.publicEndpoint === true) {
      spanOptions.root = true;
      const inbound = trace.getSpanContext(extracted);
      if (inbound !== undefined && isSpanContextValid(inbound) && inbound.isRemote === true) {
        spanOptions.links = [{ context: inbound }];
      }
    }
    const span = tracer.startSpan(spanName(method, route), spanOptions, extracted);
    let handlerContext = trace.setSpan(extracted, span);
    let record: WideRecord | undefined;
    if (summaryTelemetry !== undefined) {
      ({ context: handlerContext, record } = startRecord(handlerContext));
    }
    // The context the end is reported in, captured now: the body may finish where none is active.
    const spanContext = handlerContext;

    let finished = false;
    const finish = (outcome: Outcome): void => {
      if (finished) return;
      finished = true;
      const failure = outcome.failure;
      const failed = failure !== undefined;
      const errorType = failed
        ? errorConstructorName(failure.error)
        : outcome.status >= 500
          ? String(outcome.status)
          : undefined;
      span.setAttribute("http.response.status_code", outcome.status);
      if (errorType !== undefined) span.setAttribute("error.type", errorType);
      if (failed) {
        span.recordException(asException(failure.error));
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(failure.error) });
      } else if (outcome.status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      const seconds = (performance.now() - start) / 1000;
      histogram.record(
        seconds,
        {
          "http.request.method": method,
          "url.scheme": scheme,
          ...(httpRoute === undefined ? {} : { "http.route": httpRoute }),
          "http.response.status_code": outcome.status,
          ...(errorType === undefined ? {} : { "error.type": errorType }),
        },
        trace.setSpan(ROOT_CONTEXT, span),
      );
      if (record !== undefined && summaryTelemetry !== undefined) {
        emitSummary(summaryTelemetry, record, spanContext, {
          method,
          original,
          status: outcome.status,
          failed: failed || outcome.status >= 500,
          seconds,
          route: httpRoute,
        });
      }
      span.end();
    };

    let res: Response;
    try {
      res = await context.with(handlerContext, () => handler(req, ...rest));
    } catch (err) {
      finish({ status: 500, failure: { error: err } });
      throw err;
    }
    if ((res as Response | undefined) === undefined) {
      // Bun.serve handlers return nothing after server.upgrade(req): the connection was taken over,
      // which Go reports as 101.
      finish({ status: 101 });
      return res;
    }

    // Headers first: Bun fills in the implicit content-type of a Blob, Bun.file, FormData or
    // URLSearchParams body only when headers is read before body or bodyUsed.
    const resHeaders = res.headers;
    const status = res.status;
    if (res.bodyUsed) {
      finish({ status });
      return res;
    }
    let headers: Headers | undefined;
    if (opts.serverTiming === true && isHtml(resHeaders.get("content-type"))) {
      headers = new Headers(resHeaders);
      headers.append("server-timing", serverTiming(span));
    }
    if (res.body === null) {
      finish({ status });
      return headers === undefined ? res : rebuild(res, null, headers);
    }
    const body = watchBody(res.body, (failure) =>
      finish(failure === undefined ? { status } : { status, failure }),
    );
    return rebuild(res, body, headers ?? resHeaders);
  };
}

function spanName(method: string, route: string | undefined): string {
  if (route === undefined || route === "") return methodName(method);
  if (route.includes(" ")) return route;
  return `${methodName(method)} ${route}`;
}

// routeOnly strips a leading method from a route template ("GET /users/:id" -> "/users/:id").
function routeOnly(route: string): string {
  const space = route.indexOf(" ");
  return space < 0 ? route : route.slice(space + 1);
}

function isHtml(contentType: string | null): boolean {
  if (contentType === null) return false;
  return (contentType.split(";")[0] ?? "").trim().toLowerCase() === "text/html";
}

function serverTiming(span: Span): string {
  const sc = span.spanContext();
  const flags = (sc.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `traceparent;desc="00-${sc.traceId}-${sc.spanId}-${flags}"`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// rebuild makes a new Response: upstream responses, such as fetch's, have immutable headers.
function rebuild(res: Response, body: ReadableStream<Uint8Array> | null, headers: Headers): Response {
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Passes body through and calls done when it finishes, errors (with the error) or is cancelled by
 * the consumer. The source is read only as the consumer pulls.
 */
function watchBody(
  body: ReadableStream<Uint8Array>,
  done: (failure?: { error: unknown }) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  type ReadResult = Awaited<ReturnType<typeof reader.read>>;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let chunk: ReadResult;
        try {
          chunk = await reader.read();
        } catch (err) {
          done({ error: err });
          controller.error(err);
          return;
        }
        if (chunk.done) {
          controller.close();
          done();
          return;
        }
        controller.enqueue(chunk.value);
      },
      async cancel(reason) {
        done();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

interface Summary {
  readonly method: string;
  readonly original: string | undefined;
  readonly status: number;
  readonly failed: boolean;
  readonly seconds: number;
  readonly route: string | undefined;
}

// emitSummary emits o11y.request.summary with Go's attributes, in Go's order, after the record's.
function emitSummary(telemetry: Telemetry, record: WideRecord, ctx: Context, s: Summary): void {
  const attrs: LogAttributes = {
    "http.request.method": s.method,
    ...(s.original === undefined ? {} : { "http.request.method_original": s.original }),
    "http.response.status_code": s.status,
    [ATTR_OUTCOME]: s.failed ? OUTCOME_VALUE_FAILURE : OUTCOME_VALUE_SUCCESS,
    [ATTR_DURATION]: s.seconds,
    ...(s.route === undefined ? {} : { "http.route": s.route }),
  };
  try {
    record.emitEvent(telemetry, EVENT_REQUEST_SUMMARY, attrs, ctx);
  } catch {
    // The summary is best effort; it never fails the request.
  }
}
