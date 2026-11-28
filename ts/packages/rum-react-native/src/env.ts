/**
 * The real React Native dependencies of setupRumReactNative and screens(). The only module of the
 * main entry that reads React Native's globals and, through `@libo11y/react-native/env`, loads
 * react-native, so node tests never load it (boundary.test.ts enforces that).
 */
import { defaultReactNativeDeps, defaultReactNativeEnv } from "@libo11y/react-native/env";
import { type AppLifecycle, appStateLifecycle } from "@libo11y/react-native/internal";
import type { RumReactNativeEnv, StartupTimingLike } from "./contracts/env.ts";
import type { RumReactNativeDeps } from "./setup.ts";

const perf = (globalThis as { performance?: Performance & { rnStartupTiming?: StartupTimingLike } })
  .performance;

/** performance.now() when this module was first evaluated: the app start without rnStartupTiming. */
const LOADED_AT = perf?.now() ?? 0;

/** React Native's frames, timers and startup timing, with the app's lifecycle for visible. */
export function defaultRumEnv(
  lifecycle: AppLifecycle = appStateLifecycle(defaultReactNativeEnv().appState),
): RumReactNativeEnv {
  const startup = perf?.rnStartupTiming;
  return {
    ...(startup === undefined ? {} : { startupTiming: startup }),
    loadedAt: LOADED_AT,
    visible: () => lifecycle.visible(),
    requestAnimationFrame: (cb) => requestAnimationFrame(cb),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

/** The real dependencies of setupRumReactNativeWith. */
export function defaultRumReactNativeDeps(): RumReactNativeDeps {
  const platform = defaultReactNativeDeps();
  const now = (): number => perf?.now() ?? Date.now();
  return {
    platform,
    env: defaultRumEnv(platform.lifecycle),
    now: Date.now,
    perfNow: now,
    // React Native has performance.timeOrigin; a runtime without it counts from now.
    timeOrigin: typeof perf?.timeOrigin === "number" ? perf.timeOrigin : Date.now() - now(),
  };
}
