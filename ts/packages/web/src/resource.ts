/**
 * WP3 (web platform and setup). Browser resource detection, in the two layers core merges.
 */
import type { ResourceLayers } from "@libo11y/core";
import type { Attributes } from "@opentelemetry/api";
import { SDK_INFO } from "@opentelemetry/core";

/** The navigator fields the browser resource reads. */
export interface NavigatorLike {
  readonly userAgent?: string;
  readonly language?: string;
  readonly userAgentData?: {
    readonly brands?: readonly { readonly brand: string; readonly version: string }[];
    readonly mobile?: boolean;
    readonly platform?: string;
  };
}

/** Options for detectBrowserResource. */
export interface BrowserResourceOptions {
  readonly hermetic: boolean;
  /** Record user_agent.original. */
  readonly userAgent: boolean;
  /** The OTEL_* variables, as BrowserExportOptions.env. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Default globalThis.navigator. */
  readonly navigator?: NavigatorLike;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function browserAttributes(nav: NavigatorLike | undefined, userAgent: boolean): Attributes {
  const out: Attributes = {};
  if (nav === undefined || nav === null) return out;
  const data = nav.userAgentData;
  const brands = (data?.brands ?? [])
    .filter((b) => nonEmpty(b?.brand))
    .map((b) => (nonEmpty(b.version) ? `${b.brand} ${b.version}` : b.brand));
  if (brands.length > 0) out["browser.brands"] = brands;
  if (nonEmpty(data?.platform)) out["browser.platform"] = data.platform;
  if (typeof data?.mobile === "boolean") out["browser.mobile"] = data.mobile;
  if (nonEmpty(nav.language)) out["browser.language"] = nav.language;
  if (userAgent && nonEmpty(nav.userAgent)) out["user_agent.original"] = nav.userAgent;
  return out;
}

/**
 * The detected layer: upstream's telemetry.sdk.* (SDK_INFO), browser.brands ("<brand> <version>"
 * each, from userAgentData), browser.platform, browser.mobile, browser.language, and
 * user_agent.original when opts.userAgent is true. Absent navigator fields are omitted, never
 * empty. The environment layer: OTEL_RESOURCE_ATTRIBUTES (parseResourceAttributes) then
 * OTEL_SERVICE_NAME from opts.env; empty when hermetic. It never records the page URL, referrer,
 * screen size or anything else that identifies a user.
 */
export async function detectBrowserResource(opts: BrowserResourceOptions): Promise<ResourceLayers> {
  const sdk = Object.fromEntries(Object.entries(SDK_INFO).filter(([k]) => k.startsWith("telemetry.sdk.")));
  const nav = opts.navigator ?? (globalThis as { navigator?: NavigatorLike }).navigator;
  const detected: Attributes = { ...sdk, ...browserAttributes(nav, opts.userAgent) };
  if (opts.hermetic) return { detected, fromEnv: {} };
  const fromEnv: Attributes = parseResourceAttributes(opts.env.OTEL_RESOURCE_ATTRIBUTES);
  const serviceName = opts.env.OTEL_SERVICE_NAME?.trim();
  if (nonEmpty(serviceName)) fromEnv["service.name"] = serviceName;
  return { detected, fromEnv };
}

/**
 * Parses OTEL_RESOURCE_ATTRIBUTES as the specification defines it: comma-separated key=value
 * pairs, percent-decoded, whitespace trimmed; a malformed pair is skipped.
 */
export function parseResourceAttributes(raw: string | undefined): Attributes {
  const out: Attributes = {};
  if (raw === undefined) return out;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    try {
      const key = decodeURIComponent(pair.slice(0, eq).trim());
      const value = decodeURIComponent(pair.slice(eq + 1).trim());
      if (key !== "") out[key] = value;
    } catch {
      // A pair whose percent-encoding is malformed is skipped.
    }
  }
  return out;
}
