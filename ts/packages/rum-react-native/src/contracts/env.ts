/**
 * Contract. What the React Native RUM collectors read from the runtime. Internal: env.ts reads the
 * real globals, and tests pass a fake, so no module a test imports loads react-native.
 */

import type { ErrorUtilsLike, HermesInternalLike } from "@libo11y/react-native/internal";

/** The console errors() writes to and watches. */
export interface ConsoleLike {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** React Native's performance.rnStartupTiming, in performance.now() time. */
export interface StartupTimingLike {
  /** When the native process started, as React Native measures it. */
  readonly startTime?: number;
  readonly endTime?: number;
}

/** What the React Native RUM collectors read from the runtime. */
export interface RumReactNativeEnv {
  /** performance.rnStartupTiming, where the runtime has it. */
  readonly startupTiming?: StartupTimingLike;
  /** performance.now() when @libo11y/rum-react-native was first evaluated: the app start fallback. */
  readonly loadedAt: number;
  /** False while the app is in the background, or inactive on iOS. */
  visible(): boolean;
  requestAnimationFrame(cb: () => void): unknown;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** __DEV__. Default false. */
  readonly dev?: boolean;
  /** The global ErrorUtils errors() chains into, absent where the runtime has none (Expo web). */
  readonly errorUtils?: ErrorUtilsLike;
  /** The global HermesInternal whose rejection tracker errors() enables, absent off Hermes. */
  readonly hermes?: HermesInternalLike;
  /** The console errors() watches with console on, and warns on in development. */
  readonly console?: ConsoleLike;
}
