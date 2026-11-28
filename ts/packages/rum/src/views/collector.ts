/**
 * views(): view spans and soft navigations.
 *
 * Every view the tracker starts gets a view span named "view <o11y.rum.view.name>" with
 * o11y.rum.span.shape view, the platform, the view's name, ID and kind, and its session.id. It
 * starts at the view's startTime. A soft or bfcache_restore view span is a root, linked to the
 * action that caused it when there is one. An initial or prerender view span is a child of
 * app_load (web's documentLoad span). Its creation waits for the span processor to report
 * app_load, and once the view span is due to end it waits at most APP_LOAD_WAIT_MILLIS more, then
 * starts as a root. The tracker learns the span's context (attachSpan), so actions link to it.
 *
 * A view span ends at the first paint after its view rendered: rum.viewRendered() (router
 * adapters) or, in history mode, by itself. In history mode a soft view rendered once no DOM
 * mutation happened for RENDER_IDLE_MILLIS, a bfcache_restore view at once, and the initial view
 * at loadEventEnd when the page has loaded already, else at the first paint after the load event.
 * Every view span ends VIEW_SPAN_CAP_MILLIS after it started at the latest, and at once when its
 * view ends first. In history mode, every path change through pushState, replaceState or popstate
 * starts a soft view named by settings().viewName, caused by the open action. With history off,
 * nothing renders by itself and router adapters call rum.startView and rum.viewRendered. A runtime
 * scope with fixedView (a content script) follows no URL change, and its viewAttributes go on every
 * view span. Stop
 * ends every open view span and removes every listener, observer and timer.
 */
import {
  ATTR_RUM_PLATFORM,
  ATTR_RUM_SPAN_SHAPE,
  ATTR_RUM_VIEW_ID,
  ATTR_RUM_VIEW_KIND,
  ATTR_RUM_VIEW_NAME,
  RUM_SPAN_SHAPE_VALUE_VIEW,
} from "@libo11y/spec";
import { ROOT_CONTEXT, type Span, type SpanContext, trace } from "@opentelemetry/api";
import { ATTR_SESSION_ID } from "../attrs.ts";
import type { RumCollector, RumRuntime } from "../contracts/runtime.ts";
import type { ViewState } from "../contracts/views.ts";
import { type HistoryHost, watchHistory } from "./history.ts";
import { afterNextPaint, type PaintHost } from "./paint.ts";

/** A view span ends this long after it started at the latest. */
export const VIEW_SPAN_CAP_MILLIS = 10_000;
/** In history mode, a soft view rendered once the DOM was quiet this long. */
export const RENDER_IDLE_MILLIS = 100;
/** How long a load view span due to end waits for app_load before it starts as a root. */
export const APP_LOAD_WAIT_MILLIS = 1000;
const APP_LOAD_POLL_MILLIS = 100;

export interface ViewsOptions {
  /** Start a soft view whenever the URL path changes. Default true. Router adapters pass false and call rum.startView. */
  readonly history?: boolean;
}

/** The part of MutationObserver the collectors use. */
export interface MutationObserverLike {
  observe(target: object, options: MutationObserverInit): void;
  disconnect(): void;
}
export type MutationObserverCtor = new (cb: () => void) => MutationObserverLike;

/** What views() needs from the page. Internal: tests inject a fake. */
export interface ViewsEnv {
  /** performance.timeOrigin. */
  readonly timeOrigin: number;
  readonly paint: PaintHost;
  readonly history?: HistoryHost;
  readonly MutationObserver?: MutationObserverCtor;
  /** What mutations are observed on: document.documentElement. */
  readonly root?: object;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** The navigation entry's loadEventEnd, 0 until the load event ended. */
  navigationLoadEnd(): number;
  /** Calls cb once the load event ended. Returns its cancellation. */
  whenLoaded(cb: () => void): () => void;
}

/** The DOM mutations that count as rendering. */
export const MUTATIONS: MutationObserverInit = {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true,
};

const LOAD_SPAN_KINDS: ReadonlySet<string> = new Set(["initial", "prerender"]);

interface OpenView {
  view: ViewState;
  readonly cause?: SpanContext;
  span?: Span;
  /** performance.now() the span is to end at, once known. */
  endAt?: number;
  /** For a load view still waiting for app_load once due: when it stops waiting. */
  waitUntil?: number;
  rendered: boolean;
  readonly timers: Set<unknown>;
  observer: MutationObserverLike | undefined;
  offLoad: (() => void) | undefined;
}

export function viewsWith(opts: ViewsOptions, env: ViewsEnv): RumCollector {
  const followHistory = opts.history !== false;
  return {
    name: "views",
    start(rt: RumRuntime) {
      // A fixed view scope (a content script) keeps its one view whatever the host page's URL does.
      const history = followHistory && rt.scope?.fixedView !== true;
      let stopped = false;
      const open = new Map<string, OpenView>();

      const timer = (o: OpenView, cb: () => void, ms: number): unknown => {
        const h: unknown = env.setTimeout(() => {
          o.timers.delete(h);
          cb();
        }, ms);
        o.timers.add(h);
        return h;
      };
      const quiet = (o: OpenView): void => {
        for (const h of o.timers) env.clearTimeout(h);
        o.timers.clear();
        o.observer?.disconnect();
        o.observer = undefined;
        o.offLoad?.();
        o.offLoad = undefined;
      };
      // A fixed view (a content script) has no app_load: the host page's load is not its own.
      const waitsForAppLoad = (o: OpenView): boolean =>
        LOAD_SPAN_KINDS.has(o.view.kind) && rt.views.appLoad() === undefined && rt.scope?.fixedView !== true;

      const create = (o: OpenView): Span => {
        if (o.span !== undefined) return o.span;
        const v = o.view;
        const appLoad = LOAD_SPAN_KINDS.has(v.kind) ? rt.views.appLoad() : undefined;
        const span = rt.tracer.startSpan(
          `view ${v.name}`,
          {
            startTime: env.timeOrigin + v.startTime,
            attributes: {
              ...rt.scope?.viewAttributes,
              [ATTR_RUM_SPAN_SHAPE]: RUM_SPAN_SHAPE_VALUE_VIEW,
              [ATTR_RUM_PLATFORM]: rt.platform,
              [ATTR_RUM_VIEW_NAME]: v.name,
              [ATTR_RUM_VIEW_ID]: v.id,
              [ATTR_RUM_VIEW_KIND]: v.kind,
              [ATTR_SESSION_ID]: v.sessionId,
            },
            ...(o.cause === undefined ? {} : { links: [{ context: o.cause }] }),
          },
          appLoad === undefined ? ROOT_CONTEXT : trace.setSpanContext(ROOT_CONTEXT, appLoad),
        );
        o.span = span;
        rt.views.attachSpan(v.id, span.spanContext());
        return span;
      };
      const close = (o: OpenView): void => {
        quiet(o);
        open.delete(o.view.id);
        create(o).end(env.timeOrigin + (o.endAt ?? rt.now()));
      };
      const finish = (o: OpenView, at: number): void => {
        if (o.endAt !== undefined) return;
        o.endAt = at;
        if (o.span !== undefined || !waitsForAppLoad(o)) {
          close(o);
          return;
        }
        // The load view is due but app_load is not known yet: wait a little more for it.
        o.observer?.disconnect();
        o.observer = undefined;
        o.waitUntil = rt.now() + APP_LOAD_WAIT_MILLIS;
      };
      const poll = (o: OpenView): void => {
        timer(
          o,
          () => {
            if (rt.views.appLoad() !== undefined) {
              create(o);
              if (o.endAt !== undefined) close(o);
            } else if (o.waitUntil !== undefined && rt.now() >= o.waitUntil) close(o);
            else poll(o);
          },
          APP_LOAD_POLL_MILLIS,
        );
      };
      const paintThen = (o: OpenView): void => {
        if (o.rendered || o.endAt !== undefined) return;
        o.rendered = true;
        o.observer?.disconnect();
        o.observer = undefined;
        afterNextPaint(env.paint, rt.now, (at) => {
          if (!stopped && open.get(o.view.id) === o) finish(o, at);
        });
      };
      const detectRender = (o: OpenView): void => {
        let idle: unknown;
        const arm = (): void => {
          if (idle !== undefined) {
            env.clearTimeout(idle);
            o.timers.delete(idle);
          }
          idle = timer(o, () => paintThen(o), RENDER_IDLE_MILLIS);
        };
        if (env.MutationObserver !== undefined && env.root !== undefined) {
          o.observer = new env.MutationObserver(arm);
          o.observer.observe(env.root, MUTATIONS);
        }
        arm();
      };

      const start = (
        view: ViewState,
        cause: SpanContext | undefined,
        atSetup: boolean,
        onScreen = false,
      ): void => {
        const o: OpenView = {
          view,
          ...(cause === undefined ? {} : { cause }),
          rendered: false,
          timers: new Set(),
          observer: undefined,
          offLoad: undefined,
        };
        open.set(view.id, o);
        if (waitsForAppLoad(o)) poll(o);
        else create(o);
        const capAt = view.startTime + VIEW_SPAN_CAP_MILLIS;
        timer(o, () => finish(o, Math.min(rt.now(), capAt)), Math.max(0, capAt - rt.now()));
        // A restored page, or a view a session change started, is on screen already.
        if (onScreen || view.kind === "bfcache_restore") paintThen(o);
        else if (!history) return;
        else if (view.kind === "soft") detectRender(o);
        else if (atSetup) {
          const loadEnd = env.navigationLoadEnd();
          if (loadEnd > 0) finish(o, Math.max(view.startTime, loadEnd));
          else o.offLoad = env.whenLoaded(() => paintThen(o));
        }
      };

      const offViews = rt.views.subscribe((e) => {
        if (stopped) return;
        const o = open.get(e.view.id);
        if (e.type === "start") start(e.view, e.cause, false, e.rendered === true);
        else if (o === undefined) return;
        else if (e.type === "rename") {
          o.view = e.view;
          o.span?.updateName(`view ${e.view.name}`);
          o.span?.setAttribute(ATTR_RUM_VIEW_NAME, e.view.name);
        } else if (e.type === "rendered") {
          // A render reported before the view started (before consent) means the view was on
          // screen when it started; one reported during it ended getting into it.
          if (e.at !== undefined && e.at >= o.view.startTime && !o.rendered && o.endAt === undefined) {
            o.rendered = true;
            finish(o, Math.min(e.at, rt.now()));
          } else paintThen(o);
        } else if (e.type === "end") finish(o, rt.now());
      });
      const current = rt.views.current();
      if (current !== undefined) start(current, undefined, true);

      const unwatch =
        history && env.history !== undefined
          ? watchHistory(env.history, (url) => {
              if (stopped) return;
              const action = rt.activeAction();
              rt.views.start({
                kind: "soft",
                name: rt.settings().viewName(url),
                ...(action?.isRecording() === true ? { cause: action.spanContext() } : {}),
              });
            })
          : undefined;

      return () => {
        stopped = true;
        offViews();
        unwatch?.();
        for (const o of [...open.values()]) close(o);
      };
    },
  };
}

function browserViewsEnv(): ViewsEnv {
  const g = globalThis as typeof globalThis & {
    document?: Document;
    history?: History;
    location?: Location;
  };
  const doc = g.document;
  const loadEnd = (): number => {
    const nav = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav?.loadEventEnd ?? 0;
  };
  return {
    timeOrigin: performance.timeOrigin,
    paint: {
      ...(typeof g.requestAnimationFrame === "function"
        ? { requestAnimationFrame: (cb: () => void) => g.requestAnimationFrame(cb) }
        : {}),
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      hidden: () => doc?.visibilityState === "hidden",
    },
    ...(g.history === undefined || g.location === undefined || typeof g.addEventListener !== "function"
      ? {}
      : {
          history: {
            history: g.history,
            location: g.location,
            addEventListener: (t, l) => g.addEventListener(t, l),
            removeEventListener: (t, l) => g.removeEventListener(t, l),
          },
        }),
    ...(typeof g.MutationObserver === "function" ? { MutationObserver: g.MutationObserver } : {}),
    ...(doc?.documentElement == null ? {} : { root: doc.documentElement }),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    navigationLoadEnd: loadEnd,
    whenLoaded(cb) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // loadEventEnd is set once the load handlers ran, so wait a task after the event.
      const onLoad = (): void => {
        timer = setTimeout(cb, 0);
      };
      if (doc?.readyState === "complete") onLoad();
      else g.addEventListener?.("load", onLoad, { once: true });
      return () => {
        g.removeEventListener?.("load", onLoad);
        if (timer !== undefined) clearTimeout(timer);
      };
    },
  };
}

/** The views collector: view spans for every view, and soft navigations in history mode. */
export function views(opts: ViewsOptions = {}): RumCollector {
  return { name: "views", start: (rt) => viewsWith(opts, browserViewsEnv()).start(rt) };
}
