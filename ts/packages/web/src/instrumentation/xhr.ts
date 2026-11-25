/**
 * WP4 (instrumentation). Client spans for XMLHttpRequest.
 */
import { context, ROOT_CONTEXT, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { HttpInstrumentationOptions } from "../options.ts";
import {
  asException,
  callOnStart,
  consentAllows,
  errorName,
  type HttpInstruments,
  instrumentResolver,
  methodAttributes,
  normalizeMethod,
  pageHref,
  requestUrl,
  sentMethod,
  serverAttributes,
  spanName,
  urlAttributes,
  XHR_SETTER,
} from "./http-common.ts";
import { isIgnored, shouldPropagate } from "./origins.ts";

/** The events that end a request without a response; their type is the span's error.type. */
const FAILURE_EVENTS = ["abort", "timeout", "error"] as const;

/** What open recorded about one request, and the span of its send while in flight. */
interface Opened {
  readonly method: string;
  readonly url: URL | undefined;
  /** Ends the in-flight span; set by send, cleared when the span ends. */
  finish?: ((outcome: Outcome) => void) | undefined;
}

/** How a request ended: loadend (read status), a failure event seen before it, or a thrown error. */
type Outcome =
  | { readonly kind: "loadend" }
  | { readonly kind: "abandoned" }
  | { readonly kind: "threw"; readonly error: unknown };

/**
 * Starts the span of one send, listening for its failure events and loadend, and returns the
 * function that ends it (once, whichever outcome comes first).
 */
function startXhrSpan(
  xhr: XMLHttpRequest,
  opened: Opened & { readonly url: URL },
  instruments: HttpInstruments,
): { readonly span: Span; readonly finish: (outcome: Outcome) => void } {
  const { tracer, histogram } = instruments;
  const start = performance.now();
  const raw = opened.method;
  const { method } = normalizeMethod(raw);
  const server = serverAttributes(opened.url);
  const parent = context.active();
  const span = tracer.startSpan(
    spanName(raw),
    { kind: SpanKind.CLIENT, attributes: { ...methodAttributes(raw), ...urlAttributes(opened.url) } },
    parent,
  );
  let failure: string | undefined;
  const onFailure = (event: Event): void => {
    failure ??= event.type;
  };
  const onLoadEnd = (): void => finish({ kind: "loadend" });
  for (const type of FAILURE_EVENTS) xhr.addEventListener(type, onFailure);
  xhr.addEventListener("loadend", onLoadEnd);
  let ended = false;
  const finish = (outcome: Outcome): void => {
    if (ended) return;
    ended = true;
    for (const type of FAILURE_EVENTS) xhr.removeEventListener(type, onFailure);
    xhr.removeEventListener("loadend", onLoadEnd);
    let status: number | undefined;
    let errorType: string | undefined;
    if (outcome.kind === "threw") {
      errorType = errorName(outcome.error);
      span.recordException(asException(outcome.error));
    } else if (outcome.kind === "abandoned") {
      errorType = "abort";
    } else {
      const s = xhr.status;
      if (s === 0) errorType = failure ?? "error";
      else {
        status = s;
        if (s >= 400) errorType = String(s);
      }
    }
    if (status !== undefined) span.setAttribute("http.response.status_code", status);
    if (errorType !== undefined) {
      span.setAttribute("error.type", errorType);
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
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
  return { span, finish };
}

/** Whether installXhrInstrumentation's patch is on the prototype. */
let installed = false;

/** XMLHttpRequest.prototype's readyState DONE. */
const DONE = 4;

/**
 * Patches XMLHttpRequest.prototype.open and send: open records the method and URL (resolved
 * against the page), send starts a CLIENT span with the fetch span's name and attributes, injects
 * context by setRequestHeader under the same propagate rule, and the span ends on loadend with
 * http.response.status_code from status (status 0 is a failure with error.type from the event:
 * "abort", "timeout" or "error"). Synchronous XHR is instrumented the same way. Returns a function
 * that restores the original methods. A no-op where XMLHttpRequest does not exist (workers).
 */
export function installXhrInstrumentation(opts: HttpInstrumentationOptions = {}): () => void {
  const Xhr = (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
  if (installed || typeof Xhr !== "function") return () => {};
  const proto = Xhr.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const instruments = instrumentResolver(opts.telemetry);
  const propagateTo = opts.propagateTo ?? [];
  const ignoreUrls = opts.ignoreUrls ?? [];
  const requests = new WeakMap<XMLHttpRequest, Opened>();

  const open = function (this: XMLHttpRequest, ...args: unknown[]): void {
    // Reopening aborts a request in flight without firing loadend, so its span ends here.
    requests.get(this)?.finish?.({ kind: "abandoned" });
    const [method, url] = args;
    requests.set(this, {
      method: sentMethod(String(method)),
      url: url instanceof URL || typeof url === "string" ? requestUrl(url, pageHref()) : undefined,
    });
    // Passed on with the caller's arity: open(method, url) is async, an explicit undefined is not.
    Reflect.apply(originalOpen, this, args);
  };

  const send = function (this: XMLHttpRequest, ...args: unknown[]): void {
    const opened = requests.get(this);
    const resolved =
      opened?.url === undefined || isIgnored(opened.url, ignoreUrls) ? undefined : instruments();
    if (opened?.url === undefined || resolved === undefined || !consentAllows(resolved.consent)) {
      Reflect.apply(originalSend, this, args);
      return;
    }
    const url = opened.url;
    const { span, finish } = startXhrSpan(this, { ...opened, url }, resolved);
    opened.finish = (outcome) => {
      opened.finish = undefined;
      finish(outcome);
    };
    const end = opened.finish;
    callOnStart(opts.onStart, span, { kind: "xhr", url, method: opened.method });
    const spanContext = trace.setSpan(context.active(), span);
    try {
      if (shouldPropagate(url, propagateTo)) resolved.propagator.inject(spanContext, this, XHR_SETTER);
      context.with(spanContext, () => Reflect.apply(originalSend, this, args));
    } catch (err) {
      end({ kind: "threw", error: err });
      throw err;
    }
    // A synchronous request is done when send returns; loadend has normally ended the span already.
    if (this.readyState === DONE) end({ kind: "loadend" });
  };

  proto.open = open as typeof proto.open;
  proto.send = send as typeof proto.send;
  installed = true;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (proto.open === open) proto.open = originalOpen;
    if (proto.send === send) proto.send = originalSend;
    installed = false;
  };
}
