/**
 * useRumExpoRouter: the binding to React and Expo Router. The only module of the package that
 * imports their values, so node tests never load it; the fixture Expo app tests it under jest-expo.
 */
import type { Rum } from "@libo11y/rum";
import { usePathname, useSegments } from "expo-router";
import { useEffect, useRef } from "react";
import { createRouteTracker, type RouteTracker } from "./tracker.ts";

/**
 * Names RUM screens by Expo Router route template, such as /(studio)/projects/[projectId], never
 * by the pathname. Call it once, in the root layout, with telemetry.rum (undefined until the
 * telemetry is set up). The first route names the view RUM already started; each later pathname
 * starts a screen. Once the route has settled, the screen is marked rendered, so its view span
 * ends at the next frame and the first screen ends app_load. A navigation that a Redirect replaces
 * before it settled is one screen, named after the route that stayed.
 */
export function useRumExpoRouter(rum: Rum | undefined): void {
  const segments = useSegments() as readonly string[];
  const pathname = usePathname();
  const tracker = useRef<{ readonly rum: Rum; readonly tracker: RouteTracker } | undefined>(undefined);
  // The segments array is new on each render; its joined form is the dependency.
  const key = segments.join("/");
  useEffect(() => {
    if (rum === undefined) return;
    if (tracker.current?.rum !== rum) tracker.current = { rum, tracker: createRouteTracker(rum) };
    tracker.current.tracker.report(key === "" ? [] : key.split("/"), pathname);
  }, [rum, key, pathname]);
}

/** The props of RumExpoRouter. */
export interface RumExpoRouterProps {
  /** telemetry.rum, or undefined until the telemetry is set up. */
  readonly rum: Rum | undefined;
}

/** useRumExpoRouter as a component, for a root layout that prefers an element. Renders nothing. */
export function RumExpoRouter(props: RumExpoRouterProps): null {
  useRumExpoRouter(props.rum);
  return null;
}
