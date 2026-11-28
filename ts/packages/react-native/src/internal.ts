/**
 * @libo11y/react-native/internal: the platform's building blocks, for @libo11y/rum-react-native.
 * For libo11y packages only: it follows the package version and carries no compatibility promise.
 * Nothing reachable from here imports react-native or Expo (boundary.test.ts enforces that), so
 * node tests can load it; the binding takes the real env from ./env.
 */

export type { AppLifecycle, AppStateLike, ReactNativeEnv } from "./contracts/env.ts";
export type { KeyValueStorage } from "./contracts/storage.ts";
export { deviceClassOf } from "./device-class.ts";
export { type ExpoAppInfo, type ExpoModulesLike, expoAppInfoFrom } from "./expo/app-info.ts";
export { expoFileStorageWith, type FileLike, type FileSystemLike } from "./expo/file-storage.ts";
export { type ExpoOptions, expoOptionsFrom, withExpoOptions } from "./expo/options.ts";
export {
  installNetworkInstrumentation,
  type NetworkInstrumentation,
  type NetworkInstrumentationOptions,
  RN_SCOPE,
} from "./instrumentation/network.ts";
export { appStateLifecycle } from "./lifecycle.ts";
export type {
  ReactNativeConsentOptions,
  ReactNativeInstrumentationOptions,
  ReactNativeSetupOptions,
  ReactNativeTelemetry,
  ReactNativeTransportOptions,
} from "./options.ts";
export { MOBILE_ENV_DEFAULTS, type ReactNativePlatformOptions, reactNativePlatform } from "./platform.ts";
export { uuidCrypto } from "./random.ts";
export { detectReactNativeResource, type ReactNativeResourceOptions } from "./resource.ts";
export { type ReactNativeDeps, setupReactNativeWith } from "./setup.ts";
export { memoryStorage } from "./storage/memory.ts";
export { openStorageQueue, type StorageQueueOptions } from "./storage/queue.ts";
