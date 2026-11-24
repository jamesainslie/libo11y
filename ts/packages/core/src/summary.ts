/**
 * The startup summary: the attributes of the o11y.telemetry.configured canary, in Go's order, and
 * the one-line effective configuration. Every value is a string. Endpoints come sanitized from the
 * configuration and are listed only when their variable is set.
 *
 * The exporter values are the resolved routes (the first OTEL_*_EXPORTER value, trimmed and
 * lowercased), where Go echoes the raw variable.
 */
import { ATTR_CONFIG } from "@libo11y/spec";
import type { Resource } from "@opentelemetry/resources";
import type { ResolvedConfig } from "./config.ts";
import { LEVEL_TEXT } from "./console-sink.ts";

/** What the summary reports beyond the configuration. */
export interface SummaryFlags {
  /** Whether service.version fell back to 0.0.0-unknown. */
  readonly versionFallback: boolean;
  /** The configured propagator's fields. */
  readonly propagatorFields: readonly string[];
  /** Whether runtime metrics run. */
  readonly runtimeMetrics: boolean;
}

/** The canary attributes and the effective configuration line. */
export interface Summary {
  readonly attributes: Readonly<Record<string, string>>;
  readonly effectiveConfig: string;
}

function str(resource: Resource, key: string): string {
  const v = resource.attributes[key];
  return typeof v === "string" ? v : "";
}

/** Builds the summary from the resolved configuration and the resource. */
export function buildSummary(config: ResolvedConfig, resource: Resource, flags: SummaryFlags): Summary {
  const attrs: Record<string, string> = { "service.name": str(resource, "service.name") };
  const version = str(resource, "service.version");
  if (version !== "") attrs["service.version"] = version;
  const set = (key: string, value: string): void => {
    attrs[`${ATTR_CONFIG}.${key}`] = value;
  };
  set("traces", config.traces);
  set("metrics", config.metrics);
  set("logs", config.logs);
  set("console", config.console);
  set("level", LEVEL_TEXT[config.logLevel]);
  set("sampler", config.sampler.name);
  set("propagators", flags.propagatorFields.join(","));
  set("runtime_metrics", String(flags.runtimeMetrics));
  if (flags.versionFallback) set("service_version_fallback", "true");
  for (const key of ["endpoint", "traces_endpoint", "metrics_endpoint", "logs_endpoint"] as const) {
    const value = config.endpoints[key];
    if (value !== undefined) set(key, value);
  }
  return {
    attributes: attrs,
    effectiveConfig: Object.entries(attrs)
      .map(([k, v]) => `${k}=${v}`)
      .join(" "),
  };
}
