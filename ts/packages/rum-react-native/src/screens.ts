/**
 * screens(): the views collector of React Native (decision N10). Every view is a screen. The first
 * screen is the load view, and its span is a child of app_load; every later screen span is a root
 * linked to the action that caused it. An app has no URL to follow, so a screen starts only when
 * rum.startView starts it (a router adapter or the app), and a screen span ends at the first frame
 * after rum.viewRendered() (requestAnimationFrame, then a zero-delay task), or 10 seconds after it
 * started without one. Screens carry no web vitals.
 */
import { type RumCollector, type ViewsEnv, viewsWith } from "@libo11y/rum/core";
import type { RumReactNativeEnv } from "./contracts/env.ts";

/** The views env of a screen on React Native: frames and timers, no history, no DOM, no load event. */
function screensEnv(env: RumReactNativeEnv, timeOrigin: number): ViewsEnv {
  return {
    timeOrigin,
    paint: {
      requestAnimationFrame: (cb) => env.requestAnimationFrame(cb) as number,
      setTimeout: (cb, ms) => env.setTimeout(cb, ms),
      // An app in the background draws no frames, so a render then waits for a task only.
      hidden: () => !env.visible(),
    },
    setTimeout: (cb, ms) => env.setTimeout(cb, ms),
    clearTimeout: (h) => env.clearTimeout(h),
    navigationLoadEnd: () => 0,
    whenLoaded: () => () => {},
  };
}

/** The screens collector over env. Its name is views, as the browser's views collector's. */
export function screensWith(env: RumReactNativeEnv): RumCollector {
  return {
    name: "views",
    start: (rt) => viewsWith({ history: false }, screensEnv(env, rt.timeOrigin)).start(rt),
  };
}
