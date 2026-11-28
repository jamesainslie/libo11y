/** The public options of setupRumReactNative and its telemetry handle. */
import type { ReactNativeSetupOptions, ReactNativeTelemetry } from "@libo11y/react-native";
import type { Rum, RumOptions } from "@libo11y/rum/core";

/**
 * RUM's own options on React Native: the browser's RumOptions without URL naming, because an app
 * has no URL, plus the first screen's name. Every view is a screen.
 */
export interface RumReactNativeOptions extends Omit<RumOptions, "viewName"> {
  /**
   * The name of a screen nothing named: the first screen until a router adapter or
   * rum.setViewName names it, and a rum.startView without a name. Default "app".
   */
  readonly initialViewName?: string;
}

/** The options of setupRumReactNative: the setup options of `@libo11y/react-native` and RUM's own. */
export interface RumReactNativeSetupOptions extends ReactNativeSetupOptions {
  readonly rum?: RumReactNativeOptions;
}

/**
 * React Native telemetry with RUM. rum is the same Rum handle the browser's setupRum returns, so
 * `@libo11y/rum-react` and `@libo11y/rum-connect` accept it as it is.
 */
export interface ReactNativeRumTelemetry extends ReactNativeTelemetry {
  readonly rum: Rum;
}
