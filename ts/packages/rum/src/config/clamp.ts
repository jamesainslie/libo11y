/**
 * Remote configuration against the limits code sets (decision P16). The gateway serves
 * GET /_o11y/v1/config?service=<service.name> as {"version": "...", "config": {...}}; RUM owns
 * the keys inside config: enabled, sessionSampleRate, collectors and replay, whose object
 * @libo11y/rum-replay clamps itself. Unknown keys are ignored, so
 * the gateway may add fields. Remote values can move sessionSampleRate only within the limits the
 * code allows, can switch an installed collector off but never on one the app did not install, and
 * enabled false is the kill switch.
 */
import { O11yError } from "@libo11y/core";
import type { CollectorName, RumSettings } from "../contracts/runtime.ts";

/** One remote configuration document, flattened from the gateway's body. */
export interface RemoteConfigDocument {
  /** The gateway's version of the document, also its ETag. */
  readonly version: string;
  /** false switches RUM off at once (the kill switch). */
  readonly enabled?: boolean;
  /** The share of new sessions kept, 0 to 1, clamped to the limits. */
  readonly sessionSampleRate?: number;
  /** false switches an installed collector off. true never switches on one the app did not install. */
  readonly collectors?: Readonly<Partial<Record<CollectorName, boolean>>>;
  /** Replay's remote settings, kept as an object for @libo11y/rum-replay to clamp (R6b). */
  readonly replay?: Readonly<Record<string, unknown>>;
}

/** The range remote configuration may move a value within. */
export interface RemoteConfigLimits {
  /** The range of sessionSampleRate: min and max between 0 and 1, min not above max. Default [rate, rate]: no change. */
  readonly sessionSampleRate?: readonly [min: number, max: number];
}

/** Limits with every default applied. */
export interface ResolvedLimits {
  readonly sessionSampleRate: readonly [min: number, max: number];
}

const COLLECTORS: ReadonlySet<string> = new Set<CollectorName>([
  "views",
  "actions",
  "errors",
  "vitals",
  "resources",
  "long_animation_frames",
  "replay",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The limits for a code sample rate. The default range is [rate, rate]: no change. Throws O11yError
 * INVALID_OPTION unless 0 <= min <= max <= 1.
 */
export function resolveLimits(rate: number, limits: RemoteConfigLimits | undefined): ResolvedLimits {
  const range = limits?.sessionSampleRate;
  if (range === undefined) return { sessionSampleRate: [rate, rate] };
  const [min, max] = range;
  if (!(min >= 0 && min <= max && max <= 1)) {
    throw new O11yError(
      "INVALID_OPTION",
      "rum.remoteConfig.limits.sessionSampleRate must satisfy 0 <= min <= max <= 1",
    );
  }
  return { sessionSampleRate: [min, max] };
}

/** The document in a config endpoint body, or undefined when the body is not one. */
export function parseRemoteConfig(body: unknown): RemoteConfigDocument | undefined {
  if (!isObject(body)) return undefined;
  const { version, config } = body;
  if (typeof version !== "string" || version === "" || !isObject(config)) return undefined;
  const rate = config.sessionSampleRate;
  const collectors: Partial<Record<CollectorName, boolean>> = {};
  let anyCollector = false;
  if (isObject(config.collectors)) {
    for (const [name, on] of Object.entries(config.collectors)) {
      if (COLLECTORS.has(name) && typeof on === "boolean") {
        collectors[name as CollectorName] = on;
        anyCollector = true;
      }
    }
  }
  return {
    version,
    ...(typeof config.enabled === "boolean" ? { enabled: config.enabled } : {}),
    ...(typeof rate === "number" && rate >= 0 && rate <= 1 ? { sessionSampleRate: rate } : {}),
    ...(anyCollector ? { collectors } : {}),
    ...(isObject(config.replay) ? { replay: config.replay } : {}),
  };
}

/** The settings code sets, with doc applied within limits. */
export function clampConfig<S extends RumSettings>(
  code: S,
  doc: RemoteConfigDocument | undefined,
  limits: ResolvedLimits,
): S & { readonly enabledByRemote: boolean } {
  if (doc === undefined) return { ...code, enabledByRemote: true };
  const [lo, hi] = limits.sessionSampleRate;
  const rate =
    doc.sessionSampleRate === undefined
      ? code.sessionSampleRate
      : Math.min(Math.max(doc.sessionSampleRate, lo), hi);
  const off = doc.collectors ?? {};
  return {
    ...code,
    sessionSampleRate: rate,
    enabled: new Set([...code.enabled].filter((n) => off[n] !== false)),
    configVersion: doc.version,
    enabledByRemote: doc.enabled !== false,
  };
}
