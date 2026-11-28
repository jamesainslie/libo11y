/**
 * instrumentTanStackRouter: RUM views from TanStack Router's lifecycle events.
 *
 * A navigation that changes the path starts a soft view on onBeforeNavigate, so the view's start
 * is the navigation's start and an open action becomes its cause. onResolved names the view after
 * the route template of its deepest match, never the URL. onRendered marks the view rendered, so
 * its view span ends at the next paint. The initial load starts no view: it names and completes
 * the initial view RUM already started. A change of search or hash alone starts no view.
 *
 * The adapter needs only the structural TanStackRouterLike below, which a router-core 1.x
 * RouterCore satisfies, whichever framework adapter (React, Solid, Vue) created it.
 */
import type { Rum } from "@libo11y/rum";

/** The parts of a TanStack Router navigation event the adapter reads. */
export interface RouterNavigationEvent {
  /** Whether the path differs from the last resolved location's. */
  readonly pathChanged: boolean;
  /** The last resolved location. Undefined for the initial load. */
  readonly fromLocation?: unknown;
}

/** The parts of a TanStack Router route match the adapter reads. */
export interface RouteMatchLike {
  /** The route's ID, such as /_auth/documents/$docId. */
  readonly routeId: string;
  /** The route's full path, such as /documents/$docId. */
  readonly fullPath?: string;
}

/** The parts of a TanStack Router instance the adapter uses (router-core 1.x). */
export interface TanStackRouterLike {
  /** Adds a lifecycle event listener. Returns its removal. */
  subscribe(
    event: "onBeforeNavigate" | "onResolved" | "onRendered",
    fn: (e: RouterNavigationEvent) => void,
  ): () => void;
  /** The router's current state: its status, last resolved location and route matches. */
  readonly state: {
    readonly status?: "pending" | "idle";
    readonly resolvedLocation?: unknown;
    readonly matches: readonly RouteMatchLike[];
  };
}

const ROOT_ROUTE_ID = "__root__";

/** A routeId segment that adds nothing to the URL: a pathless layout (_auth) or a group ((app)). */
function pathless(segment: string): boolean {
  return segment.startsWith("_") || (segment.startsWith("(") && segment.endsWith(")"));
}

/**
 * The route template of the deepest match: its fullPath, else its routeId without pathless layout
 * and group segments and without the trailing underscore of a non-nested segment. The trailing
 * slash of an index route is removed. Undefined when nothing matched.
 */
export function routeTemplate(matches: readonly RouteMatchLike[]): string | undefined {
  const deepest = matches.at(-1);
  if (deepest === undefined) return undefined;
  let segments: string[];
  if (deepest.fullPath !== undefined && deepest.fullPath !== "") {
    segments = deepest.fullPath.split("/");
  } else if (deepest.routeId === ROOT_ROUTE_ID) {
    segments = [];
  } else {
    segments = deepest.routeId
      .split("/")
      .filter((s) => !pathless(s))
      .map((s) => (s.length > 1 && s.endsWith("_") ? s.slice(0, -1) : s));
  }
  const path = segments.filter((s) => s !== "").join("/");
  return `/${path}`;
}

/**
 * Names RUM views by route template and times soft navigations from router's lifecycle events.
 * Install `views({ history: false })` so the History API does not start views as well, and call this
 * right after creating the router, before it renders. Returns the uninstall.
 */
export function instrumentTanStackRouter(router: TanStackRouterLike, rum: Rum): () => void {
  const name = (): void => {
    const template = routeTemplate(router.state.matches);
    if (template !== undefined) rum.setViewName(template);
  };
  // The current view has not rendered yet: the initial view at install, and each soft view.
  let awaitingRender = true;
  const offs = [
    router.subscribe("onBeforeNavigate", (e) => {
      if (!e.pathChanged || e.fromLocation === undefined) return;
      rum.startView();
      awaitingRender = true;
    }),
    router.subscribe("onResolved", (e) => {
      if (e.pathChanged) name();
    }),
    router.subscribe("onRendered", () => {
      if (!awaitingRender) return;
      awaitingRender = false;
      rum.viewRendered();
    }),
  ];
  // A router that resolved before instrumentation has rendered its first route already.
  if (router.state.status === "idle" && router.state.resolvedLocation !== undefined) {
    name();
    awaitingRender = false;
    rum.viewRendered();
  }
  return () => {
    for (const off of offs) off();
  };
}
