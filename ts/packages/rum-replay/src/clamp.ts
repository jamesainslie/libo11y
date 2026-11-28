/**
 * Remote configuration of replay. The gateway's configuration document (GET /_o11y/v1/config) may carry an optional replay object:
 * { enabled?: false, sampleRate?: number, onRetain?: false, mask?: string[], block?: string[], unmask?: string[] }.
 *
 * Remote configuration can only make replay stricter:
 * - enabled and onRetain are honoured only as false: they switch replay or the lead-up buffer off,
 *   never on.
 * - sampleRate can only lower the rate: down to the minimum of the limits code sets (default
 *   [rate, rate], no change), never above the code rate.
 * - mask and block selectors are added after the fixed and code ones, which stay.
 * - unmask is intersected with the code list, so it can only remove selectors. It can never add one.
 * - A selector that is not a string, is empty or fails validSelector is dropped, and so is every
 *   unknown field.
 *
 * The clamped settings are pinned for the session by the collector, like the rest of
 * document.
 */
import { O11yError } from "@libo11y/core";
import type { ReplayPolicy } from "./policy.ts";

/** The replay object of a remote configuration document, after parseReplayRemote. */
export interface ReplayRemote {
  readonly enabled?: false;
  readonly sampleRate?: number;
  readonly onRetain?: false;
  readonly mask?: readonly string[];
  readonly block?: readonly string[];
  readonly unmask?: readonly string[];
}

/** Replay's settings: from code, then clamped by remote configuration. */
export interface ReplaySettings {
  readonly enabled: boolean;
  readonly sampleRate: number;
  readonly onRetain: boolean;
  readonly policy: ReplayPolicy;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function selectorList(v: unknown, validSelector: (s: string) => boolean): readonly string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((s): s is string => {
    if (typeof s !== "string" || s.trim() === "") return false;
    try {
      return validSelector(s);
    } catch {
      return false;
    }
  });
}

/**
 * The replay object of a remote configuration document with everything that could loosen replay
 * removed, or undefined when value is not an object. validSelector says whether a CSS selector
 * parses; in a browser the collector passes one that tries document.createDocumentFragment().querySelector.
 */
export function parseReplayRemote(
  value: unknown,
  validSelector: (s: string) => boolean,
): ReplayRemote | undefined {
  if (!isObject(value)) return undefined;
  const rate = value.sampleRate;
  const mask = selectorList(value.mask, validSelector);
  const block = selectorList(value.block, validSelector);
  const unmask = selectorList(value.unmask, validSelector);
  return {
    ...(value.enabled === false ? { enabled: false as const } : {}),
    ...(typeof rate === "number" && rate >= 0 && rate <= 1 ? { sampleRate: rate } : {}),
    ...(value.onRetain === false ? { onRetain: false as const } : {}),
    ...(mask === undefined ? {} : { mask }),
    ...(block === undefined ? {} : { block }),
    ...(unmask === undefined ? {} : { unmask }),
  };
}

/**
 * The range remote configuration may move the replay sample rate within. The default is
 * [rate, rate]: no change. Throws O11yError INVALID_OPTION unless 0 <= min <= rate <= max <= 1.
 * Remote configuration only ever lowers the rate, so min is the bound that matters: clampReplay
 * never goes above the code rate, whatever max says.
 */
export function resolveReplayLimits(
  rate: number,
  limits: { readonly sampleRate?: readonly [min: number, max: number] } | undefined,
): readonly [min: number, max: number] {
  const range = limits?.sampleRate;
  if (range === undefined) return [rate, rate];
  const [min, max] = range;
  if (!(min >= 0 && min <= rate && rate <= max && max <= 1)) {
    throw new O11yError(
      "INVALID_OPTION",
      "replay limits.sampleRate must satisfy 0 <= min <= sampleRate <= max <= 1",
    );
  }
  return [min, max];
}

function append(base: readonly string[], extra: readonly string[] | undefined): readonly string[] {
  const out = [...base];
  for (const s of extra ?? []) if (!out.includes(s)) out.push(s);
  return Object.freeze(out);
}

/** code tightened by remote within limits. See the file comment. */
export function clampReplay(
  code: ReplaySettings,
  limits: readonly [min: number, max: number],
  remote: ReplayRemote | undefined,
): ReplaySettings {
  if (remote === undefined) return code;
  // Remote configuration only lowers the rate: never above the code rate, never below min.
  const hi = Math.min(limits[1], code.sampleRate);
  const lo = Math.min(limits[0], hi);
  const unmask = remote.unmask;
  return Object.freeze({
    enabled: code.enabled && remote.enabled !== false,
    onRetain: code.onRetain && remote.onRetain !== false,
    sampleRate:
      remote.sampleRate === undefined ? code.sampleRate : Math.min(Math.max(remote.sampleRate, lo), hi),
    policy: Object.freeze({
      unmask:
        unmask === undefined
          ? code.policy.unmask
          : Object.freeze(code.policy.unmask.filter((s) => unmask.includes(s))),
      mask: append(code.policy.mask, remote.mask),
      block: append(code.policy.block, remote.block),
      queryAllowList: code.policy.queryAllowList,
    }),
  });
}
