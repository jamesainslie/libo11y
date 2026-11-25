/**
 * WP3 (web platform and setup). Browser resource detection, in the two layers core merges.
 */
import type { ResourceLayers } from "@libo11y/core";
import type { Attributes } from "@opentelemetry/api";

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

/**
 * The detected layer: upstream's telemetry.sdk.* (SDK_INFO), browser.brands ("<brand> <version>"
 * each, from userAgentData), browser.platform, browser.mobile, browser.language, and
 * user_agent.original when opts.userAgent is true. Absent navigator fields are omitted, never
 * empty. The environment layer: OTEL_RESOURCE_ATTRIBUTES (parseResourceAttributes) then
 * OTEL_SERVICE_NAME from opts.env; empty when hermetic. It never records the page URL, referrer,
 * screen size or anything else that identifies a user.
 */
export function detectBrowserResource(opts: BrowserResourceOptions): Promise<ResourceLayers> {
  void opts;
  throw new Error("not implemented");
}

/**
 * Parses OTEL_RESOURCE_ATTRIBUTES as the specification defines it: comma-separated key=value
 * pairs, percent-decoded, whitespace trimmed; a malformed pair is skipped.
 */
export function parseResourceAttributes(raw: string | undefined): Attributes {
  void raw;
  throw new Error("not implemented");
}
