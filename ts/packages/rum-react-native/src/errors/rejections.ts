/**
 * Hermes's promise rejection tracker. Hermes keeps one tracker, the last one enabled, and React
 * Native enables its own (the LogBox warning) only in development, so in development this replaces
 * it. It cannot be removed again.
 */
import type { HermesInternalLike } from "@libo11y/react-native/internal";
import { diag } from "@opentelemetry/api";

/**
 * Enables Hermes's rejection tracker for all rejections, calling onUnhandled with each unhandled
 * reason. Returns false where there is no tracker (Expo web, JSC) or enabling it threw.
 */
export function installRejectionTracker(
  hermes: HermesInternalLike | undefined,
  onUnhandled: (reason: unknown) => void,
): boolean {
  if (typeof hermes?.enablePromiseRejectionTracker !== "function") return false;
  try {
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (_id, rejection) => onUnhandled(rejection),
      onHandled: () => {},
    });
    return true;
  } catch (err) {
    diag.warn("o11y: rum: enabling the Hermes rejection tracker failed", err);
    return false;
  }
}
