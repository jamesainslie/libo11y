/**
 * The RUM span processor. On every span start it adds session.id, o11y.rum.view.id (unless the
 * span already names them) and user.id,
 * removes disallowed query parameters from url.full, and turns web's documentLoad span into the
 * app_load shape of the load view: it is renamed app_load and carries o11y.rum.span.shape app_load,
 * the attribute the gateway keys on. Its documentFetch child also belongs to the load view, and it
 * is not a request of the view. It publishes client request starts and ends on the bus for
 * actions, summaries and errors, and a breadcrumb for each finished request: "fetch <METHOD> <host>
 * <status or failed>", or "rpc <method>" for a span with rpc.method, never a path. It runs before the exporting processors, so they see the
 * attributes. A span that starts while the session loads after a grant gets the same treatment,
 * and waits in pending for its session.id and view (R3f).
 */
import {
  ATTR_RUM_PLATFORM,
  ATTR_RUM_SPAN_SHAPE,
  ATTR_RUM_VIEW_ID,
  RUM_SPAN_SHAPE_VALUE_APP_LOAD,
  type RUMPlatform,
} from "@libo11y/spec";
import { type Context, SpanKind } from "@opentelemetry/api";
import { hrTimeToMilliseconds } from "@opentelemetry/core";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace";
import { ATTR_SESSION_ID, ATTR_USER_ID } from "./attrs.ts";
import type { RumBus } from "./contracts/runtime.ts";
import type { SessionManager } from "./contracts/session.ts";
import type { ViewTracker } from "./contracts/views.ts";
import type { PendingSpans } from "./pending-spans.ts";
import { stripQuery } from "./query.ts";

/** The name of the app_load span shape. */
export const APP_LOAD_SPAN = "app_load";
const DOCUMENT_LOAD = "documentLoad";
/** web's child of documentLoad: the document request, part of the load and not a request the view made. */
const DOCUMENT_FETCH = "documentFetch";
const WEB_SCOPE = "@libo11y/web";

export interface RumSpanProcessorOptions {
  readonly platform: RUMPlatform;
  readonly session: Pick<SessionManager, "current">;
  readonly views: Pick<ViewTracker, "current" | "loadView" | "appLoadStarted">;
  readonly queryAllowList: () => ReadonlySet<string>;
  readonly userId: () => string | undefined;
  readonly bus: RumBus;
  /** performance.now(). */
  readonly now: () => number;
  /**
   * performance.timeOrigin, to read a span's end time on the now() clock. Without it the bus
   * reports now() alone.
   */
  readonly timeOrigin?: number;
  /** Where spans that start while the session loads wait for it. */
  readonly pending?: Pick<PendingSpans, "isOpen" | "hold">;
}

function fromWeb(span: ReadableSpan, name: string): boolean {
  return span.name === name && span.instrumentationScope.name === WEB_SCOPE;
}

function hostOf(span: ReadableSpan): string {
  const address = span.attributes["server.address"];
  if (typeof address === "string" && address !== "") return address;
  const full = span.attributes["url.full"];
  try {
    return typeof full === "string" ? new URL(full).hostname : "";
  } catch {
    return "";
  }
}

function isRequest(span: ReadableSpan): boolean {
  return (
    span.kind === SpanKind.CLIENT &&
    typeof span.attributes["http.request.method"] === "string" &&
    !fromWeb(span, DOCUMENT_FETCH)
  );
}

export function rumSpanProcessor(opts: RumSpanProcessorOptions): SpanProcessor {
  // Request spans this processor announced, so request-end is published only for them.
  const announced = new Set<string>();
  return {
    onStart(span: Span, _parent: Context) {
      const session = opts.session.current();
      if (session === undefined && opts.pending?.isOpen() !== true) return;
      const appLoad = fromWeb(span, DOCUMENT_LOAD);
      const ofLoad = appLoad || fromWeb(span, DOCUMENT_FETCH);
      if (session === undefined) {
        // Consent is granted and the session still loading: the span waits for it.
        opts.pending?.hold(span, ofLoad);
      } else {
        // RUM's own view and action spans name their view and session, which may be older ones.
        if (span.attributes[ATTR_SESSION_ID] === undefined) span.setAttribute(ATTR_SESSION_ID, session.id);
        const view = ofLoad ? opts.views.loadView() : opts.views.current();
        if (view !== undefined && span.attributes[ATTR_RUM_VIEW_ID] === undefined) {
          span.setAttribute(ATTR_RUM_VIEW_ID, view.id);
        }
      }
      const user = opts.userId();
      if (user !== undefined) span.setAttribute(ATTR_USER_ID, user);
      const full = span.attributes["url.full"];
      const url = typeof full === "string" ? stripQuery(full, opts.queryAllowList()) : undefined;
      if (url !== undefined && url !== full) span.setAttribute("url.full", url);
      if (appLoad) {
        span.updateName(APP_LOAD_SPAN);
        span.setAttribute(ATTR_RUM_SPAN_SHAPE, RUM_SPAN_SHAPE_VALUE_APP_LOAD);
        span.setAttribute(ATTR_RUM_PLATFORM, opts.platform);
        opts.views.appLoadStarted(span.spanContext());
      }
      if (isRequest(span)) {
        const spanId = span.spanContext().spanId;
        const parent = span.parentSpanContext?.spanId;
        announced.add(spanId);
        opts.bus.publish({
          type: "request-start",
          spanId,
          ...(parent === undefined ? {} : { parentSpanId: parent }),
          method: String(span.attributes["http.request.method"]),
          url: url ?? "",
          at: opts.now(),
        });
      }
    },
    onEnd(span: ReadableSpan) {
      const spanId = span.spanContext().spanId;
      if (!announced.delete(spanId)) return;
      const status = span.attributes["http.response.status_code"];
      const errorType = span.attributes["error.type"];
      // The later of now and the span's own end, so an action that settles at this time never
      // ends before the request it caused (WebKit's span end can trail now() by a millisecond).
      const origin = opts.timeOrigin;
      const spanEnd = origin === undefined ? Number.NaN : hrTimeToMilliseconds(span.endTime) - origin;
      const at = Number.isFinite(spanEnd) ? Math.max(opts.now(), spanEnd) : opts.now();
      opts.bus.publish({
        type: "request-end",
        spanId,
        ...(typeof status === "number" ? { status } : {}),
        ...(typeof status !== "number" && typeof errorType === "string" ? { errorType } : {}),
        at,
      });
      const rpc = span.attributes["rpc.method"];
      opts.bus.publish(
        rpc === undefined
          ? {
              type: "breadcrumb",
              kind: "fetch",
              label: `${String(span.attributes["http.request.method"])} ${hostOf(span)} ${typeof status === "number" ? status : "failed"}`,
              at,
            }
          : { type: "breadcrumb", kind: "rpc", label: String(rpc), at },
      );
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}
