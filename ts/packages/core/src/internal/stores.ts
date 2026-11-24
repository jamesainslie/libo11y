/**
 * The exemplar store of each Telemetry, for @libo11y/core/testing's exemplarStoreOf. Module-private
 * to core: createTelemetryWith registers, the testing subpath reads.
 */
import type { ExemplarStore } from "../exemplars.ts";

const stores = new WeakMap<object, ExemplarStore>();

/** Records the store a Telemetry samples into. */
export function registerExemplarStore(telemetry: object, store: ExemplarStore): void {
  stores.set(telemetry, store);
}

/** The store a Telemetry samples into, if core created it. */
export function exemplarStoreFor(telemetry: object): ExemplarStore | undefined {
  return stores.get(telemetry);
}
