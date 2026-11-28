/**
 * resources(): one span per resource performance entry the page loaded.
 *
 * Rules. Entries are observed buffered, so the first start also records the resources loaded before
 * it; a later start (consent granted again) records only resources that started after it. Skipped:
 * fetch, xmlhttprequest and beacon initiators (their client spans exist), non-HTTP URLs, and URLs
 * the runtime or env ignores (the OTLP endpoints and instrumentations.ignoreUrls). A span is named
 * "resource <o11y.rum.resource.type>" (resourceType), is a client span, starts at timeOrigin +
 * startTime and ends at timeOrigin + responseEnd. Its attributes: o11y.rum.resource.type, url.full
 * with the query stripped by the allow-list, server.address, http.response.status_code when
 * responseStatus > 0, http.response.body.size when encodedBodySize > 0, and the session.id and
 * o11y.rum.view.id of its view. It carries no http.request.method, so it is not a request of the
 * view and no action waits for it.
 *
 * A resource that started before loadEventEnd, or while the load is under way, belongs to the load
 * view and is a child of app_load (web's documentLoad span). Such resources wait until app_load is
 * known, polling every RESOURCE_POLL_MILLIS, and after the load ended they wait at most
 * RESOURCE_APP_LOAD_WAIT_MILLIS before they are recorded as roots. Any other resource belongs to
 * the current view and is a root linked to that view's span when it is known. A Server-Timing
 * traceparent adds a link to the server span; every other Server-Timing entry becomes a
 * server_timing span event at the span's start with o11y.rum.server_timing.name and
 * o11y.rum.server_timing.duration (seconds). At most maxPerView spans per view. Stop drops
 * resources still waiting and stops observing.
 */
import {
  ATTR_RUM_RESOURCE_TYPE,
  ATTR_RUM_SERVER_TIMING_DURATION,
  ATTR_RUM_SERVER_TIMING_NAME,
  ATTR_RUM_VIEW_ID,
  type RUMResourceType,
} from "@libo11y/spec";
import { type Attributes, type Link, ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";
import { ATTR_SESSION_ID } from "../attrs.ts";
import type { RumCollector } from "../contracts/runtime.ts";
import type { ViewState } from "../contracts/views.ts";
import { stripQuery } from "../query.ts";
import { readServerTiming, type ServerTimingEntryLike } from "./server-timing.ts";

export type { ServerTimingEntryLike } from "./server-timing.ts";

/** Options of resources(). */
export interface ResourcesOptions {
  /** Most resource spans per view. Default 150. */
  readonly maxPerView?: number;
}

/** The fields of a PerformanceResourceTiming entry RUM reads. Times are performance.now() milliseconds. */
export interface ResourceEntryLike {
  readonly name: string;
  readonly initiatorType: string;
  readonly startTime: number;
  readonly responseEnd: number;
  readonly encodedBodySize?: number;
  readonly responseStatus?: number;
  readonly serverTiming?: readonly ServerTimingEntryLike[];
}

/** What resources() needs from the page. Internal: tests inject a fake. */
export interface ResourcesEnv {
  /** performance.timeOrigin. */
  readonly timeOrigin: number;
  /** Observes resource entries, buffered ones first. Returns the function that stops observing. */
  observe(cb: (entries: readonly ResourceEntryLike[]) => void): () => void;
  /** The navigation entry's loadEventEnd, 0 until the load event ended. */
  loadEventEnd(): number;
  /** URLs to skip beyond the runtime's own. */
  ignore?(url: string): boolean;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_MAX_PER_VIEW = 150;
/** How often resources of the load poll for app_load. */
export const RESOURCE_POLL_MILLIS = 100;
/** How long after the load ended resources of the load wait for app_load before they become roots. */
export const RESOURCE_APP_LOAD_WAIT_MILLIS = 1000;

const SKIPPED_INITIATORS: ReadonlySet<string> = new Set(["fetch", "xmlhttprequest", "beacon"]);

/** The resource type of each initiator type; any other initiator is other. */
export const RESOURCE_TYPES: Readonly<Record<string, RUMResourceType>> = {
  script: "script",
  css: "stylesheet",
  link: "stylesheet",
  img: "image",
  image: "image",
  input: "image",
  video: "media",
  audio: "media",
  track: "media",
  iframe: "document",
  frame: "document",
};

/** Initiators that load several kinds of resource, so the URL's extension decides. */
const BY_EXTENSION_INITIATORS: ReadonlySet<string> = new Set(["css", "link", "other"]);
const EXTENSION_TYPES: Readonly<Record<string, RUMResourceType>> = {
  woff: "font",
  woff2: "font",
  ttf: "font",
  otf: "font",
  eot: "font",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  svg: "image",
  ico: "image",
  js: "script",
  mjs: "script",
  css: "stylesheet",
};

function extensionOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf(".");
    return dot < 0 || dot < path.lastIndexOf("/") ? "" : path.slice(dot + 1).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The resource type of an entry: by initiator type, except that a css, link or other initiator with
 * a font, image, script or stylesheet extension takes the extension's type (fonts and background
 * images load with the css initiator).
 */
export function resourceType(entry: Pick<ResourceEntryLike, "name" | "initiatorType">): RUMResourceType {
  if (BY_EXTENSION_INITIATORS.has(entry.initiatorType)) {
    const byExtension = EXTENSION_TYPES[extensionOf(entry.name)];
    if (byExtension !== undefined) return byExtension;
  }
  return RESOURCE_TYPES[entry.initiatorType] ?? "other";
}

function httpUrl(href: string): URL | undefined {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

/** For tests: the resources collector over an injected page. */
export function resourcesWith(opts: ResourcesOptions, env: ResourcesEnv): RumCollector {
  const maxPerView = opts.maxPerView ?? DEFAULT_MAX_PER_VIEW;
  let starts = 0;
  return {
    name: "resources",
    start(rt) {
      starts++;
      /** A restart records only resources that started after it. */
      const since = starts === 1 ? Number.NEGATIVE_INFINITY : rt.now();
      const perView = new Map<string, number>();
      const waiting: { entry: ResourceEntryLike; view: ViewState }[] = [];
      let poll: unknown;
      let giveUpAt: number | undefined;
      let stopped = false;

      const record = (entry: ResourceEntryLike, view: ViewState, inLoad: boolean): void => {
        const n = perView.get(view.id) ?? 0;
        if (n >= maxPerView) return;
        perView.set(view.id, n + 1);
        const url = httpUrl(entry.name);
        if (url === undefined) return;
        const type = resourceType(entry);
        const st = readServerTiming(entry.serverTiming ?? []);
        const attributes: Attributes = {
          [ATTR_RUM_RESOURCE_TYPE]: type,
          "url.full": stripQuery(url.href, rt.settings().queryAllowList),
          "server.address": url.hostname,
          [ATTR_SESSION_ID]: view.sessionId,
          [ATTR_RUM_VIEW_ID]: view.id,
          ...(entry.responseStatus !== undefined && entry.responseStatus > 0
            ? { "http.response.status_code": entry.responseStatus }
            : {}),
          ...(entry.encodedBodySize !== undefined && entry.encodedBodySize > 0
            ? { "http.response.body.size": entry.encodedBodySize }
            : {}),
        };
        const appLoad = inLoad ? rt.views.appLoad() : undefined;
        const links: Link[] = [];
        if (!inLoad && view.spanContext !== undefined) links.push({ context: view.spanContext });
        if (st.remote !== undefined) links.push({ context: st.remote });
        const start = env.timeOrigin + entry.startTime;
        const span = rt.tracer.startSpan(
          `resource ${type}`,
          { kind: SpanKind.CLIENT, startTime: start, attributes, ...(links.length === 0 ? {} : { links }) },
          appLoad === undefined ? ROOT_CONTEXT : trace.setSpanContext(ROOT_CONTEXT, appLoad),
        );
        for (const e of st.entries) {
          span.addEvent(
            "server_timing",
            { [ATTR_RUM_SERVER_TIMING_NAME]: e.name, [ATTR_RUM_SERVER_TIMING_DURATION]: e.seconds },
            start,
          );
        }
        span.end(env.timeOrigin + Math.max(entry.responseEnd, entry.startTime));
      };

      const drain = (): void => {
        poll = undefined;
        if (stopped) return;
        const known = rt.views.appLoad() !== undefined;
        const loaded = env.loadEventEnd() > 0;
        if (loaded && giveUpAt === undefined) giveUpAt = rt.now() + RESOURCE_APP_LOAD_WAIT_MILLIS;
        if (known || (giveUpAt !== undefined && rt.now() >= giveUpAt)) {
          for (const w of waiting.splice(0)) record(w.entry, w.view, true);
          return;
        }
        poll = env.setTimeout(drain, RESOURCE_POLL_MILLIS);
      };

      const onEntries = (entries: readonly ResourceEntryLike[]): void => {
        if (stopped || !rt.gate.recording()) return;
        for (const entry of entries) {
          if (entry.startTime < since || SKIPPED_INITIATORS.has(entry.initiatorType)) continue;
          if (
            httpUrl(entry.name) === undefined ||
            rt.ignored(entry.name) ||
            env.ignore?.(entry.name) === true
          ) {
            continue;
          }
          const loadEnd = env.loadEventEnd();
          const inLoad = loadEnd === 0 || entry.startTime < loadEnd;
          const view = inLoad ? rt.views.loadView() : rt.views.current();
          if (view === undefined) continue;
          if (inLoad && rt.views.appLoad() === undefined) waiting.push({ entry, view });
          else record(entry, view, inLoad);
        }
        if (waiting.length > 0 && poll === undefined) drain();
      };

      const unobserve = env.observe(onEntries);
      return () => {
        stopped = true;
        waiting.length = 0;
        if (poll !== undefined) env.clearTimeout(poll);
        poll = undefined;
        unobserve();
      };
    },
  };
}

function browserResourcesEnv(): ResourcesEnv {
  return {
    timeOrigin: performance.timeOrigin,
    observe(cb) {
      if (typeof PerformanceObserver === "undefined") return () => {};
      const observer = new PerformanceObserver((list) => {
        cb(list.getEntries() as unknown as readonly ResourceEntryLike[]);
      });
      try {
        observer.observe({ type: "resource", buffered: true });
      } catch {
        return () => {};
      }
      return () => observer.disconnect();
    },
    loadEventEnd() {
      const nav = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
      return nav?.loadEventEnd ?? 0;
    },
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

/** The resources collector: a span for each script, stylesheet, image, font, media or frame the page loads. */
export function resources(opts: ResourcesOptions = {}): RumCollector {
  let inner: RumCollector | undefined;
  return {
    name: "resources",
    start(rt) {
      inner ??= resourcesWith(opts, browserResourcesEnv());
      return inner.start(rt);
    },
  };
}
