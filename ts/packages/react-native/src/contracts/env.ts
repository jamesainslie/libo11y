/**
 * Contract. What React Native telemetry reads from React Native. Internal: env.ts reads the real
 * modules, and tests pass a fake, so no module a test imports loads react-native.
 */

/** The part of React Native's AppState the telemetry uses. */
export interface AppStateLike {
  readonly currentState: string | null | undefined;
  addEventListener(type: "change", listener: (state: string) => void): { remove(): void };
}

/** What React Native telemetry reads from React Native. */
export interface ReactNativeEnv {
  readonly appState: AppStateLike;
  /** Platform.OS, such as "ios" or "android". */
  readonly os: string;
  /** Platform.isPad (iOS). */
  readonly isPad: boolean;
  /** Platform.isTV. */
  readonly isTV: boolean;
  /** Dimensions.get("screen") in points (dp), or undefined when it is not known. */
  readonly screen: () => { readonly width: number; readonly height: number } | undefined;
  /** __DEV__. */
  readonly dev: boolean;
}

/** When the app is in the foreground. */
export interface AppLifecycle {
  /** False while the app is in the background, or inactive on iOS. */
  visible(): boolean;
  /**
   * Calls listener once per change between visible and hidden, in registration order. Returns the
   * function that unsubscribes.
   */
  subscribe(listener: (visible: boolean) => void): () => void;
}
