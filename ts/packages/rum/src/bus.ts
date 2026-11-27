import { diag } from "@opentelemetry/api";
import type { RumBus, RumSignal } from "./contracts/runtime.ts";

/** A synchronous in-page bus. A throwing listener is reported through diag and the rest still run. */
export function createBus(): RumBus {
  const listeners = new Set<(signal: RumSignal) => void>();
  return {
    publish(signal) {
      for (const l of listeners) {
        try {
          l(signal);
        } catch (err) {
          diag.warn(`o11y: rum: ${signal.type} listener threw`, err);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
