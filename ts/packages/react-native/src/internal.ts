/**
 * @libo11y/react-native/internal: the platform's building blocks, for @libo11y/rum-react-native.
 * For libo11y packages only: it follows the package version, carries no compatibility promise and
 * has no API report. Nothing reachable from here imports react-native (boundary.test.ts enforces
 * that), so node tests can load it; the binding passes the real env from the main entry.
 */

export type { AppLifecycle, AppStateLike, ReactNativeEnv } from "./contracts/env.ts";
export type { KeyValueStorage } from "./contracts/storage.ts";
export { deviceClassOf } from "./device-class.ts";
export {
  installNetworkInstrumentation,
  type NetworkInstrumentation,
  type NetworkInstrumentationOptions,
  RN_SCOPE,
} from "./instrumentation/network.ts";
export { appStateLifecycle } from "./lifecycle.ts";
export { MOBILE_ENV_DEFAULTS, type ReactNativePlatformOptions, reactNativePlatform } from "./platform.ts";
export { uuidCrypto } from "./random.ts";
export { detectReactNativeResource, type ReactNativeResourceOptions } from "./resource.ts";
export { type ReactNativeDeps, setupReactNativeWith } from "./setup.ts";
export { memoryStorage } from "./storage/memory.ts";
export { openStorageQueue, type StorageQueueOptions } from "./storage/queue.ts";
