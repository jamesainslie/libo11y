/** The stored session record every session store shares: version 1 JSON under one key. */
import { RUM_SESSION_RETAINED_VALUES, type RUMSessionRetained } from "@libo11y/spec";
import type { SessionState } from "../contracts/session.ts";

export const SESSION_STORAGE_KEY = "libo11y.rum.session";

const RETAINED: ReadonlySet<string> = new Set(RUM_SESSION_RETAINED_VALUES);

/** The SessionState in a stored or broadcast record, or undefined when it is not a valid version 1 record. */
export function parseSessionState(value: unknown): SessionState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  if (r.v !== 1 || typeof r.id !== "string" || r.id === "") return undefined;
  if (typeof r.startedAt !== "number" || typeof r.lastActivityAt !== "number") return undefined;
  if (typeof r.sampled !== "boolean") return undefined;
  if (r.retained !== undefined && (typeof r.retained !== "string" || !RETAINED.has(r.retained)))
    return undefined;
  if (r.configVersion !== undefined && typeof r.configVersion !== "string") return undefined;
  return {
    id: r.id,
    startedAt: r.startedAt,
    lastActivityAt: r.lastActivityAt,
    sampled: r.sampled,
    ...(r.retained === undefined ? {} : { retained: r.retained as RUMSessionRetained }),
    ...(r.configVersion === undefined ? {} : { configVersion: r.configVersion }),
  };
}
