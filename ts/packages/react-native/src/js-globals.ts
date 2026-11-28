/**
 * React Native's JavaScript globals that are not modules: ErrorUtils, which InitializeCore installs
 * before the app's code runs, and Hermes's HermesInternal. Each is absent where the runtime lacks it
 * or it does not have the shape RUM calls, so a caller never checks again.
 */
import type { ErrorUtilsLike, HermesInternalLike } from "./contracts/env.ts";

/** The globals of g RUM uses: globalThis on a device. */
export function jsGlobals(g: object): { errorUtils?: ErrorUtilsLike; hermes?: HermesInternalLike } {
  const { ErrorUtils: eu, HermesInternal: hermes } = g as { ErrorUtils?: unknown; HermesInternal?: unknown };
  const errorUtils =
    typeof eu === "object" &&
    eu !== null &&
    typeof (eu as ErrorUtilsLike).getGlobalHandler === "function" &&
    typeof (eu as ErrorUtilsLike).setGlobalHandler === "function"
      ? (eu as ErrorUtilsLike)
      : undefined;
  return {
    ...(errorUtils === undefined ? {} : { errorUtils }),
    ...(typeof hermes === "object" && hermes !== null ? { hermes: hermes as HermesInternalLike } : {}),
  };
}
