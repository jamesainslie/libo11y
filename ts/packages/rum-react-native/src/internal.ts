/**
 * @libo11y/rum-react-native/internal: the building blocks, for libo11y packages and fixtures. For
 * libo11y packages only: it follows the package version and carries no compatibility promise.
 * Nothing reachable from here imports react-native or Expo (boundary.test.ts enforces that), so
 * node tests can load it.
 */

export { runtimeOf } from "@libo11y/rum/core";
export { type AppStart, type AppStartOptions, createAppStart } from "./app-start.ts";
export {
  type ReactNativeBindingOptions,
  type ReactNativeRumBind,
  reactNativeBinding,
  rumLifecycle,
} from "./binding.ts";
export { preloadedStorage } from "./config-cache.ts";
export type { RumReactNativeEnv, StartupTimingLike } from "./contracts/env.ts";
export type {
  ReactNativeRumTelemetry,
  RumReactNativeOptions,
  RumReactNativeSetupOptions,
} from "./options.ts";
export { screensWith } from "./screens.ts";
export { storageSessionStore } from "./session-store.ts";
export { APP_LOCATION, type RumReactNativeDeps, setupRumReactNativeWith } from "./setup.ts";
