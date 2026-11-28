/**
 * The documentLoad span. RUM adds the app_load shape's attributes to it through a span
 * processor; @libo11y/web records only what the navigation entry says.
 */
import {
  type Attributes,
  type Context,
  diag,
  type HrTime,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { addHrTimes, millisToHrTime } from "@opentelemetry/core";
import { activeConsent } from "../consent/active.ts";
import type { Consent } from "../contracts/consent.ts";
import type { DocumentLoadOptions } from "../options.ts";
import { VERSION } from "../version.ts";
import { consentAllows, consentOf, isHttpUrl, SCOPE, urlAttributes } from "./http-common.ts";
import {
  remoteParentFromTraceparent,
  type ServerTimingLike,
  traceparentFromServerTiming,
} from "./server-timing.ts";

/** The span names. */
export const DOCUMENT_LOAD_SPAN = "documentLoad";
export const DOCUMENT_FETCH_SPAN = "documentFetch";

/** The PerformanceNavigationTiming fields the spans read, in milliseconds since the time origin. */
export interface NavigationTimingLike {
  /** The document URL. */
  readonly name: string;
  readonly startTime: number;
  readonly fetchStart: number;
  readonly domainLookupStart?: number;
  readonly domainLookupEnd?: number;
  readonly connectStart?: number;
  readonly secureConnectionStart?: number;
  readonly connectEnd?: number;
  readonly requestStart?: number;
  readonly responseStart?: number;
  readonly responseEnd: number;
  readonly unloadEventStart?: number;
  readonly unloadEventEnd?: number;
  readonly domInteractive?: number;
  readonly domContentLoadedEventStart?: number;
  readonly domContentLoadedEventEnd?: number;
  readonly domComplete?: number;
  readonly loadEventStart?: number;
  readonly loadEventEnd: number;
  /** The HTTP status, where the browser exposes it; 0 when it hides it. */
  readonly responseStatus?: number;
  readonly serverTiming?: readonly ServerTimingLike[];
}

type Mark = keyof NavigationTimingLike;

// The marks of each span, in navigation order, as upstream's document-load instrumentation.
const FETCH_MARKS: readonly Mark[] = [
  "fetchStart",
  "domainLookupStart",
  "domainLookupEnd",
  "connectStart",
  "secureConnectionStart",
  "connectEnd",
  "requestStart",
  "responseStart",
  "responseEnd",
];
const LOAD_MARKS: readonly Mark[] = [
  "fetchStart",
  "unloadEventStart",
  "unloadEventEnd",
  "domInteractive",
  "domContentLoadedEventStart",
  "domContentLoadedEventEnd",
  "domComplete",
  "loadEventStart",
  "loadEventEnd",
];

/** url.path and url.scheme of the document, never its query or fragment. */
function documentAttributes(href: string): Attributes {
  try {
    const url = new URL(href);
    return { "url.path": url.pathname, "url.scheme": url.protocol.slice(0, -1) };
  } catch {
    return {};
  }
}

/**
 * The HTTP client attributes of the document's request, for an http: or https: document: GET (the
 * navigation entry does not say the method), server.address, server.port, and url.full sanitized
 * as on fetch spans, with the query and fragment also left out, as on every document attribute.
 */
function documentFetchAttributes(href: string): Attributes {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return {};
  }
  if (!isHttpUrl(url)) return {};
  url.search = "";
  url.hash = "";
  return { "http.request.method": "GET", ...urlAttributes(url) };
}

/**
 * Records the documentLoad span and its documentFetch child from a navigation entry, with times
 * relative to timeOrigin (epoch milliseconds). Internal: the pure builder recordDocumentLoad uses.
 */
export function recordNavigationSpans(tracer: Tracer, entry: NavigationTimingLike, timeOrigin: number): void {
  const origin = millisToHrTime(timeOrigin);
  const at = (ms: number): HrTime => addHrTimes(origin, millisToHrTime(ms));
  const addMarks = (span: Span, marks: readonly Mark[]): void => {
    for (const mark of marks) {
      const value = entry[mark];
      // fetchStart is always set; any other mark at 0 did not happen (no unload, no TLS, ...).
      if (typeof value === "number" && (value > 0 || mark === "fetchStart")) span.addEvent(mark, at(value));
    }
  };

  const traceparent = traceparentFromServerTiming(entry.serverTiming ?? []);
  const remote = traceparent === undefined ? undefined : remoteParentFromTraceparent(traceparent);
  const parent: Context = remote === undefined ? ROOT_CONTEXT : trace.setSpanContext(ROOT_CONTEXT, remote);
  const attributes = documentAttributes(entry.name);

  const load = tracer.startSpan(
    DOCUMENT_LOAD_SPAN,
    { kind: SpanKind.INTERNAL, startTime: at(entry.startTime), attributes },
    parent,
  );
  const status = entry.responseStatus;
  const fetchSpan = tracer.startSpan(
    DOCUMENT_FETCH_SPAN,
    {
      kind: SpanKind.CLIENT,
      startTime: at(entry.fetchStart),
      attributes: {
        ...attributes,
        ...documentFetchAttributes(entry.name),
        ...(typeof status === "number" && status > 0 ? { "http.response.status_code": status } : {}),
      },
    },
    trace.setSpan(parent, load),
  );
  addMarks(fetchSpan, FETCH_MARKS);
  fetchSpan.end(at(entry.responseEnd));
  addMarks(load, LOAD_MARKS);
  load.end(at(entry.loadEventEnd));
}

/** The page globals recordDocumentLoad reads. Internal: tests inject a fake page. */
export interface DocumentLoadEnv {
  readonly document:
    | (Pick<EventTarget, "addEventListener" | "removeEventListener"> & {
        readonly readyState: string;
        readonly visibilityState: string;
      })
    | undefined;
  /** Where load and pagehide fire. */
  readonly window: Pick<EventTarget, "addEventListener" | "removeEventListener"> | undefined;
  readonly performance:
    | { readonly timeOrigin: number; getEntriesByType(type: string): readonly unknown[] }
    | undefined;
  /** Default globalThis.setTimeout. */
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
}

/** The pages (by their performance object) whose documentLoad span was recorded. */
const recorded = new WeakSet<object>();

type Timers = { setTimeout(fn: () => void, ms: number): unknown };

/** Resolves true after the load event and one task after it, or false on abort. */
function afterLoad(env: DocumentLoadEnv, signal: AbortSignal | undefined): Promise<boolean> {
  const { document, window } = env;
  const schedule = env.setTimeout ?? ((fn, ms) => (globalThis as unknown as Timers).setTimeout(fn, ms));
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      window?.removeEventListener("load", onLoad);
      signal?.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const onAbort = (): void => finish(false);
    // loadEventEnd is set when the load handlers return, so read the entry one task later.
    const onLoad = (): void => {
      window?.removeEventListener("load", onLoad);
      schedule(() => finish(signal?.aborted !== true), 0);
    };
    signal?.addEventListener("abort", onAbort);
    if (document?.readyState === "complete" || window === undefined) onLoad();
    else window.addEventListener("load", onLoad);
  });
}

/** Resolves true on the first grant, or false when the page is hidden or the signal aborts first. */
function untilGranted(
  consent: Consent,
  env: DocumentLoadEnv,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const { document, window } = env;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      document?.removeEventListener("visibilitychange", onVisibility);
      window?.removeEventListener("pagehide", onHide);
      signal?.removeEventListener("abort", onHide);
      resolve(ok);
    };
    const onHide = (): void => finish(false);
    const onVisibility = (): void => {
      if (document?.visibilityState === "hidden") finish(false);
    };
    document?.addEventListener("visibilitychange", onVisibility);
    window?.addEventListener("pagehide", onHide);
    signal?.addEventListener("abort", onHide);
    unsubscribe = consent.subscribe((state) => {
      if (state === "granted") finish(true);
    });
    if (settled) unsubscribe();
    else if (consentAllows(consent)) finish(true);
  });
}

/** The navigation entry of the page, if the browser has one. */
function navigationEntry(env: DocumentLoadEnv): NavigationTimingLike | undefined {
  const [entry] = env.performance?.getEntriesByType("navigation") ?? [];
  return entry as NavigationTimingLike | undefined;
}

/** recordDocumentLoad over an explicit page environment. Internal: the seam the unit tests drive. */
export async function recordDocumentLoadWith(opts: DocumentLoadOptions, env: DocumentLoadEnv): Promise<void> {
  const { performance, document } = env;
  const { signal } = opts;
  try {
    if (document === undefined || performance === undefined || recorded.has(performance)) return;
    if (signal?.aborted === true || !(await afterLoad(env, signal))) return;
    const entry = navigationEntry(env);
    if (entry === undefined) return;
    const consent = opts.telemetry === undefined ? activeConsent() : consentOf(opts.telemetry);
    if (consent !== undefined && !consentAllows(consent) && !(await untilGranted(consent, env, signal)))
      return;
    if (recorded.has(performance)) return;
    recorded.add(performance);
    const provider = opts.telemetry?.tracerProvider ?? trace.getTracerProvider();
    recordNavigationSpans(provider.getTracer(SCOPE, VERSION), entry, performance.timeOrigin);
  } catch (err) {
    diag.warn(`libo11y: recordDocumentLoad failed: ${String(err)}`);
  }
}

/**
 * Records, once per page, an INTERNAL span "documentLoad" from the PerformanceNavigationTiming
 * entry's startTime to loadEventEnd, with a child CLIENT span "documentFetch" from fetchStart to
 * responseEnd. The documentLoad span's parent is the remote context of the entry's Server-Timing
 * traceparent when there is one (traceparentFromServerTiming), else none. Attributes: url.path and
 * url.scheme of the document (never the query or fragment), and on documentFetch the HTTP client
 * attributes of an http: or https: document (http.request.method GET, server.address, server.port
 * and url.full, sanitized as on fetch spans and without the query or fragment) and
 * http.response.status_code from responseStatus when the browser exposes it. The navigation
 * timing marks (fetchStart, domainLookupStart, ..., loadEventEnd) are span events at their times.
 *
 * Waits for the load event (and one task after it, so loadEventEnd is set). If consent is not
 * granted then, waits for the first grant and records then, with the same historical times; if the
 * page is hidden first, records nothing. Resolves when the span ended or was abandoned; never
 * rejects. A no-op without document or a navigation entry.
 */
export function recordDocumentLoad(opts: DocumentLoadOptions = {}): Promise<void> {
  const g = globalThis as {
    document?: DocumentLoadEnv["document"];
    performance?: DocumentLoadEnv["performance"];
    addEventListener?: unknown;
  };
  const window =
    typeof g.addEventListener === "function" ? (globalThis as unknown as EventTarget) : undefined;
  const performance = typeof g.performance?.getEntriesByType === "function" ? g.performance : undefined;
  return recordDocumentLoadWith(opts, { document: g.document, window, performance });
}
