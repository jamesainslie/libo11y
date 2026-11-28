/**
 * @libo11y/rum-react-native/internal: the building blocks, for libo11y packages and fixtures. For
 * libo11y packages only: it follows the package version, carries no compatibility promise and has
 * no API report. Nothing reachable from here imports react-native or Expo (boundary.test.ts
 * enforces that), so node tests can load it.
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
export type { ConsoleLike, RumReactNativeEnv, StartupTimingLike } from "./contracts/env.ts";
export {
  errorsWith,
  FATAL_FLUSH_MILLIS,
  type RnErrorsEnv,
  type RnErrorsOptions,
} from "./errors/collector.ts";
export { BUNDLE_URLS, bundleUrlOf, mapHermesStack } from "./errors/hermes-stack.ts";
export { installRejectionTracker } from "./errors/rejections.ts";
export { screensWith } from "./screens.ts";
export { storageSessionStore } from "./session-store.ts";
export { APP_LOCATION, type RumReactNativeDeps, setupRumReactNativeWith } from "./setup.ts";
