/** Resolves RumOptions into RumSettings, refusing invalid values. */
import { O11yError } from "@libo11y/core";
import type { CollectorName, RumCollector, RumSettings } from "./contracts/runtime.ts";
import type { RumOptions } from "./options.ts";
import { defaultViewName } from "./views/naming.ts";

/** The settings, the collectors to start and the client token. */
export interface ResolvedRum extends RumSettings {
  readonly collectors: readonly RumCollector[];
  readonly clientToken?: string;
}

function positive(name: string, v: number | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  if (!(Number.isFinite(v) && v > 0))
    throw new O11yError("INVALID_OPTION", `rum.${name} must be a positive number`);
  return v;
}

/** The settings for o. Throws O11yError INVALID_OPTION for an invalid value. */
export function resolveSettings(o: RumOptions | undefined): ResolvedRum {
  const rate = o?.sessionSampleRate ?? 1;
  if (!(rate >= 0 && rate <= 1))
    throw new O11yError("INVALID_OPTION", "rum.sessionSampleRate must be between 0 and 1");
  if (o?.clientToken !== undefined && (typeof o.clientToken !== "string" || o.clientToken === "")) {
    throw new O11yError("INVALID_OPTION", "rum.clientToken must be a non-empty string");
  }
  const collectors = o?.collectors ?? [];
  const names = new Set<CollectorName>();
  for (const c of collectors) {
    if (names.has(c.name)) throw new O11yError("INVALID_OPTION", `rum.collectors lists ${c.name} twice`);
    names.add(c.name);
  }
  return {
    sessionSampleRate: rate,
    sessionIdleMillis: positive("sessionIdleMillis", o?.sessionIdleMillis, 900_000),
    sessionMaxMillis: positive("sessionMaxMillis", o?.sessionMaxMillis, 14_400_000),
    queryAllowList: new Set(o?.queryAllowList ?? []),
    enabled: names,
    viewName: o?.viewName ?? defaultViewName,
    collectors,
    ...(o?.clientToken === undefined ? {} : { clientToken: o.clientToken }),
  };
}
