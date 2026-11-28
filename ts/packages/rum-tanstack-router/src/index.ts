/**
 * TanStack Router adapter for `@libo11y/rum`: views named by route template, with soft
 * navigations timed to the first paint after the new route rendered.
 */
export {
  instrumentTanStackRouter,
  type RouteMatchLike,
  type RouterNavigationEvent,
  routeTemplate,
  type TanStackRouterLike,
} from "./instrument.ts";
export { VERSION } from "./version.ts";
