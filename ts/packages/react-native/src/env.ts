/**
 * @libo11y/react-native/env: the real React Native dependencies, for @libo11y/rum-react-native's
 * binding, which wraps them. For libo11y packages only: it follows the package version and carries
 * no compatibility promise. The only module of this package that imports a value from react-native,
 * so node tests never load it (boundary.test.ts enforces that).
 */
import {
  createConsentController,
  createDelivery,
  createExporterSet,
  createHttpTransport,
} from "@libo11y/web/portable";
import { AppState, Dimensions, Platform } from "react-native";
import type { ReactNativeEnv } from "./contracts/env.ts";
import { installNetworkInstrumentation } from "./instrumentation/network.ts";
import { appStateLifecycle } from "./lifecycle.ts";
import type { ReactNativeDeps } from "./setup.ts";
import { openStorageQueue } from "./storage/queue.ts";

export type { AppLifecycle, AppStateLike, ReactNativeEnv } from "./contracts/env.ts";
export type { KeyValueStorage } from "./contracts/storage.ts";
export type { NetworkInstrumentation, NetworkInstrumentationOptions } from "./instrumentation/network.ts";
export type { ReactNativeDeps } from "./setup.ts";
export type { StorageQueueOptions } from "./storage/queue.ts";

declare const __DEV__: boolean | undefined;

/** React Native's AppState, Platform and Dimensions, read when called. */
export function defaultReactNativeEnv(): ReactNativeEnv {
  const p = Platform as { OS: string; isPad?: boolean; isTV?: boolean };
  return {
    appState: AppState,
    os: p.OS,
    isPad: p.isPad === true,
    isTV: p.isTV === true,
    screen: () => {
      const s = Dimensions.get("screen");
      return { width: s.width, height: s.height };
    },
    dev: typeof __DEV__ === "boolean" ? __DEV__ : false,
  };
}

/** The real dependencies of setupReactNativeWith over env. */
export function defaultReactNativeDeps(env: ReactNativeEnv = defaultReactNativeEnv()): ReactNativeDeps {
  return {
    env,
    lifecycle: appStateLifecycle(env.appState),
    createConsentController,
    openQueue: openStorageQueue,
    createHttpTransport,
    createDelivery,
    createExporterSet,
    installNetworkInstrumentation,
  };
}
