/**
 * Fakes of React Native's ErrorUtils and Hermes's HermesInternal for errors(): the original global
 * handler records its calls, throwGlobal calls whatever handler is installed, the rejection tracker
 * keeps the options it was enabled with, the console records warn and error calls, and timers run
 * on a manual clock. Never built.
 */
import type { GlobalErrorHandler, PromiseRejectionTrackerOptions } from "@libo11y/react-native/internal";
import { manualTimers } from "../../../rum/src/test-support/manual-timers.ts";
import type { RumReactNativeEnv } from "../contracts/env.ts";

export interface FakeRn {
  readonly env: RumReactNativeEnv;
  /** React Native's own handler, installed before RUM. */
  readonly original: GlobalErrorHandler;
  /** The calls the original handler received: [error, isFatal]. */
  previousCalls(): [unknown, boolean | undefined][];
  /** Calls the installed global handler, as React Native does for an uncaught error. */
  throwGlobal(error: unknown, isFatal?: boolean): void;
  /** Whether a rejection tracker was enabled. */
  trackerInstalled(): boolean;
  /** The options of the last tracker enabled. */
  tracker(): PromiseRejectionTrackerOptions | undefined;
  /** Reports an unhandled rejection to the last tracker enabled. */
  reject(reason: unknown): void;
  /** console.warn calls. */
  warnings(): unknown[][];
  /** console.error calls that reached the original console.error. */
  consoleErrors(): unknown[][];
  /** Moves the manual clock, running the timers that fall due. */
  advance(ms: number): void;
}

export function fakeRn(over: { readonly dev?: boolean } = {}): FakeRn {
  const clock = manualTimers(0);
  const calls: [unknown, boolean | undefined][] = [];
  const original: GlobalErrorHandler = (error, isFatal) => {
    calls.push([error, isFatal]);
  };
  let handler = original;
  let tracker: PromiseRejectionTrackerOptions | undefined;
  let nextId = 0;
  const warnings: unknown[][] = [];
  const consoleErrors: unknown[][] = [];
  const env: RumReactNativeEnv = {
    loadedAt: 0,
    visible: () => true,
    requestAnimationFrame: () => 0,
    setTimeout: (cb, ms) => clock.timers.setTimeout(cb, ms),
    clearTimeout: (h) => clock.timers.clearTimeout(h),
    dev: over.dev ?? false,
    errorUtils: {
      getGlobalHandler: () => handler,
      setGlobalHandler: (h) => {
        handler = h;
      },
    },
    hermes: {
      enablePromiseRejectionTracker: (o) => {
        tracker = o;
      },
      hasPromise: () => true,
    },
    console: {
      warn: (...a: unknown[]) => void warnings.push(a),
      error: (...a: unknown[]) => void consoleErrors.push(a),
    },
  };
  return {
    env,
    original,
    previousCalls: () => calls,
    throwGlobal: (error, isFatal) => handler(error, isFatal),
    trackerInstalled: () => tracker !== undefined,
    tracker: () => tracker,
    reject: (reason) => tracker?.onUnhandled?.(nextId++, reason),
    warnings: () => warnings,
    consoleErrors: () => consoleErrors,
    advance: (ms) => clock.advance(ms),
  };
}
