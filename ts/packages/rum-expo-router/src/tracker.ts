/**
 * The route tracker: the RUM screens of an Expo Router app, from the route each commit shows.
 *
 * A report whose pathname differs from the last report's is a navigation. The first report names
 * the view RUM already started (the load view, a child of app_load); every later one starts a
 * screen. The route then has to settle: viewRendered is deferred (by default to a zero-delay
 * timer), so a navigation that a Redirect or router.replace in an effect replaces before it
 * settled is one view, named after the route that stayed, as a redirect is in
 * `@libo11y/rum-tanstack-router`. A report with the pathname of the last one, such as a change of
 * search params, changes nothing.
 */
import type { Rum } from "@libo11y/rum";
import { routeTemplate } from "./template.ts";

/** The Rum methods the tracker calls. */
export type RouteTrackerRum = Pick<Rum, "startView" | "setViewName" | "viewRendered">;

/** Runs fn later, once the commit has settled. Returns its cancellation. */
export type RouteTrackerDefer = (fn: () => void) => () => void;

/** Turns the route of each commit into RUM screens. */
export interface RouteTracker {
  /**
   * Reports the route a commit shows: its segments, as useSegments() returns them, and its
   * pathname. A new pathname is a navigation; the same one changes nothing.
   */
  report(segments: readonly string[], pathname: string): void;
}

const zeroDelay: RouteTrackerDefer = (fn) => {
  const handle = setTimeout(fn, 0);
  return () => clearTimeout(handle);
};

/**
 * A route tracker over rum. defer postpones viewRendered until the commit settled; the default is
 * a zero-delay timer, which runs after a redirect's render committed.
 */
export function createRouteTracker(rum: RouteTrackerRum, defer: RouteTrackerDefer = zeroDelay): RouteTracker {
  let last: string | undefined;
  // The view of the last navigation has not rendered yet; cancel drops its deferred viewRendered.
  let cancel: (() => void) | undefined;
  return {
    report(segments, pathname) {
      if (pathname === last) return;
      const name = routeTemplate(segments);
      if (last === undefined || cancel !== undefined) rum.setViewName(name);
      else rum.startView({ name });
      last = pathname;
      cancel?.();
      cancel = defer(() => {
        cancel = undefined;
        rum.viewRendered();
      });
    },
  };
}
