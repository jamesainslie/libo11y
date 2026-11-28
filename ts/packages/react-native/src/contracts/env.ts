/**
 * Contract. What React Native telemetry reads from React Native. Internal: env.ts reads the real
 * modules, and tests pass a fake, so no module a test imports loads react-native.
 */

/** The part of React Native's AppState the telemetry uses. */
export interface AppStateLike {
  readonly currentState: string | null | undefined;
  addEventListener(type: "change", listener: (state: string) => void): { remove(): void };
}

/** React Native's global error handler: every uncaught JavaScript error, fatal or not. */
export type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

/** The part of React Native's global ErrorUtils (`@react-native/js-polyfills`) RUM chains into. */
export interface ErrorUtilsLike {
  getGlobalHandler(): GlobalErrorHandler;
  setGlobalHandler(handler: GlobalErrorHandler): void;
}

/** The options of Hermes's promise rejection tracker, as the promise package's rejection tracking takes them. */
export interface PromiseRejectionTrackerOptions {
  readonly allRejections?: boolean;
  readonly onUnhandled?: (id: number, rejection: unknown) => void;
  readonly onHandled?: (id: number, rejection?: unknown) => void;
}

/** The part of Hermes's global HermesInternal RUM uses. Only one rejection tracker is active: the last enabled. */
export interface HermesInternalLike {
  enablePromiseRejectionTracker?(options: PromiseRejectionTrackerOptions): void;
  hasPromise?(): boolean;
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
  /** The global ErrorUtils, absent where the runtime has none (Expo web). */
  readonly errorUtils?: ErrorUtilsLike;
  /** The global HermesInternal, absent where the engine is not Hermes (Expo web, JSC). */
  readonly hermes?: HermesInternalLike;
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
