/**
 * libo11y RUM for React Native apps on Hermes: setupRumReactNative over `@libo11y/react-native`,
 * and the collectors it runs. telemetry.rum is the browser's Rum handle, so `@libo11y/rum-react`
 * and `@libo11y/rum-connect` work with it as they are.
 */

export type { KeyValueStorage, ReactNativeSetupOptions, ReactNativeTelemetry } from "@libo11y/react-native";
export type {
  AddErrorOptions,
  CollectorName,
  RemoteConfig,
  RemoteConfigOptions,
  RequestStartHook,
  Rum,
  RumCollector,
  RumOptions,
  RumRuntime,
} from "@libo11y/rum";

import type { RemoteConfig, RemoteConfigOptions, RumCollector } from "@libo11y/rum";
import { remoteConfig as portableRemoteConfig } from "@libo11y/rum/core";
import { defaultRumEnv, defaultRumReactNativeDeps } from "./env.ts";
import type { ReactNativeRumTelemetry, RumReactNativeSetupOptions } from "./options.ts";
import { screensWith } from "./screens.ts";
import { setupRumReactNativeWith } from "./setup.ts";

export type {
  ReactNativeRumTelemetry,
  RumReactNativeOptions,
  RumReactNativeSetupOptions,
} from "./options.ts";
export { VERSION } from "./version.ts";

/**
 * Builds React Native telemetry with RUM and installs it globally, as setupReactNative does. Every
 * view is a screen, and the first is named rum.initialViewName (default "app") until a router
 * adapter or rum.setViewName names it. Nothing is recorded, stored or sent until consent is
 * granted, unless consent.initial is "granted". options.storage holds the retry queue, the
 * retention buffer, the session (a relaunch within the idle window continues it) and the remote
 * configuration cache. The app_load span runs from the process start to the first screen's
 * rum.viewRendered(), once per process, also when consent comes later. Calling it twice without a
 * shutdown rejects with ALREADY_SETUP.
 */
export function setupRumReactNative(
  options: RumReactNativeSetupOptions = {},
): Promise<ReactNativeRumTelemetry> {
  return setupRumReactNativeWith(options, defaultRumReactNativeDeps(), true);
}

/**
 * The screens collector: a view span per screen, ending at the first frame after
 * rum.viewRendered() or 10 seconds after it started. The first screen's span is a child of
 * app_load; a later screen's is a root linked to the action that caused it. Pass it in
 * rum.collectors.
 */
export function screens(): RumCollector {
  return screensWith(defaultRumEnv());
}

/**
 * Remote configuration from the RUM gateway, as `@libo11y/rum`'s remoteConfig, for rum.remoteConfig.
 * It is fetched only once consent is granted, and cached in the app's storage.
 */
export function remoteConfig(opts: RemoteConfigOptions = {}): RemoteConfig {
  return portableRemoteConfig(opts);
}
