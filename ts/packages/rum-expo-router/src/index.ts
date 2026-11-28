/**
 * The Expo Router adapter for `@libo11y/rum-react-native`: useRumExpoRouter names screens by route
 * template and marks each rendered, so its view span, and the first screen's app_load, end at the
 * next frame after the route settled.
 */

export { RumExpoRouter, type RumExpoRouterProps, useRumExpoRouter } from "./hook.ts";
export { routeTemplate } from "./template.ts";
export {
  createRouteTracker,
  type RouteTracker,
  type RouteTrackerDefer,
  type RouteTrackerRum,
} from "./tracker.ts";
export { VERSION } from "./version.ts";
