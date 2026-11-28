/**
 * Contract. What the React Native RUM collectors read from the runtime. Internal: env.ts reads the
 * real globals, and tests pass a fake, so no module a test imports loads react-native.
 */

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
}
