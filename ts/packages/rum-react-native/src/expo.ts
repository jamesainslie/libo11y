/**
 * libo11y RUM for Expo apps: setupRumReactNative with the options `@libo11y/react-native/expo`
 * fills in, the retry queue, the retention buffer, the session and the remote configuration
 * cache in the app's documents (expo-file-system), the app version (expo-application), the ID of
 * the over-the-air update the app runs (expo-updates) and the device class (expo-device).
 */
import { expoOptions } from "@libo11y/react-native/expo";
import { withExpoOptions } from "@libo11y/react-native/internal";
import { setupRumReactNative } from "./index.ts";
import type { ReactNativeRumTelemetry, RumReactNativeSetupOptions } from "./options.ts";

export type {
  ReactNativeRumTelemetry,
  RumReactNativeOptions,
  RumReactNativeSetupOptions,
} from "./options.ts";

/**
 * setupRumReactNative with expoOptions() under the app's own options: an option the app sets
 * wins, and resourceAttributes merge key by key with the app's winning, as setupExpo does.
 */
export function setupRumExpo(options: RumReactNativeSetupOptions = {}): Promise<ReactNativeRumTelemetry> {
  return setupRumReactNative(withExpoOptions(expoOptions(), options));
}
