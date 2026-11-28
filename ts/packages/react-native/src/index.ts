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
export type { KeyValueStorage } from "./contracts/storage.ts";
export type {
  ReactNativeConsentOptions,
  ReactNativeInstrumentationOptions,
  ReactNativeSetupOptions,
  ReactNativeTelemetry,
  ReactNativeTransportOptions,
} from "./options.ts";
export { VERSION } from "./version.ts";
