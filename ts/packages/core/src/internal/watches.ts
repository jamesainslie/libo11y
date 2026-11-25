/**
 * The metric export watch of each telemetry, found through its exemplar store. A platform builds
 * the metric reader, so core never sees the reader's exporter. It does see it pass through
 * exemplarMetricExporter, which the platform calls with the store, and that is where the watch is
 * put on. Module-private to core: build registers, exemplarMetricExporter reads.
 */
import type { ExemplarStore } from "../exemplars.ts";
import type { ExportWatch } from "../export-watch.ts";

const watches = new WeakMap<ExemplarStore, ExportWatch>();

/** Records the watch for the metric exporters wrapped with store. */
export function registerMetricWatch(store: ExemplarStore, watch: ExportWatch): void {
  watches.set(store, watch);
}

/** The watch for the metric exporters wrapped with store, if a telemetry owns it. */
export function metricWatchFor(store: ExemplarStore): ExportWatch | undefined {
  return watches.get(store);
}
