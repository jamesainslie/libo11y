/**
 * The libo11y React Native platform: setup over the OpenTelemetry JS providers on Hermes, the mobile
 * resource, an OTLP/HTTP transport whose retry queue saves every batch on device storage before it
 * is sent, flushing when the app goes to the background, the consent gate, and fetch and XHR spans
 * with origin-scoped propagation. No RUM features: those come with @libo11y/rum-react-native.
 */

export {
  type LifecycleOptions,
  type Logger,
  O11yError,
  type O11yErrorCode,
  type SignalReport,
  type Telemetry,
  type TelemetryOptions,
} from "@libo11y/core";
export type { Consent, ConsentState, UrlMatcher } from "@libo11y/web";

import { defaultReactNativeDeps } from "./env.ts";
import type { ReactNativeSetupOptions, ReactNativeTelemetry } from "./options.ts";
import { setupReactNativeWith } from "./setup.ts";

export type { KeyValueStorage } from "./contracts/storage.ts";
export type {
  ReactNativeConsentOptions,
  ReactNativeInstrumentationOptions,
  ReactNativeSetupOptions,
  ReactNativeTelemetry,
  ReactNativeTransportOptions,
} from "./options.ts";
export { memoryStorage } from "./storage/memory.ts";
export { VERSION } from "./version.ts";

/**
 * Builds React Native telemetry and installs it globally, as the server's and the web's setup do:
 * the providers, the propagator and the context manager, the fetch and XMLHttpRequest patches as
 * options.instrumentations says, flushing when the app goes to the background (AppState) and
 * draining the retry queue when it comes back. Nothing is recorded, stored or sent until consent
 * is granted, unless consent.initial is "granted". Every batch is saved in options.storage before it
 * is sent, so a batch exported just before the app stops goes out on the next launch. Every
 * endpoint must be an absolute http or https URL. Calling it twice without a shutdown rejects with
 * ALREADY_SETUP.
 */
export function setupReactNative(options: ReactNativeSetupOptions = {}): Promise<ReactNativeTelemetry> {
  return setupReactNativeWith(options, defaultReactNativeDeps(), true);
}
