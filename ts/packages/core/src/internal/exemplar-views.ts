/**
 * The renaming views of each telemetry's meter provider, found through its exemplar store. A view
 * with a name gives an instrument's stream a new name, and the store, which samples by instrument
 * name, looks the renamed stream's instrument up here. Module-private to core: telemetry
 * registers, ExemplarStore.attach reads.
 */
import type { ViewOptions } from "@opentelemetry/sdk-metrics";
import type { ExemplarStore } from "../exemplars.ts";

/**
 * One view that renames a stream: the stream's new name and the selector of the one instrument it
 * derives from. sdk-metrics refuses a view with a name whose instrumentName is missing or has a
 * wildcard ("Views with a specified name must be declared with an instrument selector that selects
 * at most one instrument per meter"), so instrumentName is always one exact name.
 */
export interface ExemplarRename {
  readonly name: string;
  readonly instrumentName: string;
  readonly instrumentType?: string;
  readonly instrumentUnit?: string;
  readonly meterName?: string;
  readonly meterVersion?: string;
  readonly meterSchemaUrl?: string;
}

const renames = new WeakMap<ExemplarStore, readonly ExemplarRename[]>();

/** Records the views of the meter provider whose measurements store samples. */
export function registerExemplarViews(store: ExemplarStore, views: readonly ViewOptions[]): void {
  const list: ExemplarRename[] = [];
  for (const v of views) {
    if (v.name === undefined || v.instrumentName === undefined || v.name === v.instrumentName) continue;
    list.push({
      name: v.name,
      instrumentName: v.instrumentName,
      ...(v.instrumentType === undefined ? {} : { instrumentType: v.instrumentType }),
      ...(v.instrumentUnit === undefined ? {} : { instrumentUnit: v.instrumentUnit }),
      ...(v.meterName === undefined ? {} : { meterName: v.meterName }),
      ...(v.meterVersion === undefined ? {} : { meterVersion: v.meterVersion }),
      ...(v.meterSchemaUrl === undefined ? {} : { meterSchemaUrl: v.meterSchemaUrl }),
    });
  }
  renames.set(store, list);
}

/** The renaming views registered for store, or none. */
export function exemplarRenamesFor(store: ExemplarStore): readonly ExemplarRename[] {
  return renames.get(store) ?? [];
}
