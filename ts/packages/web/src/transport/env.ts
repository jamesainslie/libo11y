/** The OTEL_* variables a platform reports, from its export options and endpoints. */
import { OTLP_SIGNALS } from "../contracts/otlp.ts";
import type { BrowserExportOptions } from "../options.ts";
import type { SignalEndpoints } from "./endpoints.ts";

/**
 * The OTEL_* variables the platform reports: envDefaults, then exportOptions.env, then
 * OTEL_EXPORTER_OTLP_PROTOCOL=http/json, then OTEL_<SIGNAL>_EXPORTER=none for each signal whose
 * endpoint is undefined unless env names an exporter for it.
 */
export function browserEnv(
  exportOptions: BrowserExportOptions,
  endpoints: SignalEndpoints,
  envDefaults?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = { ...envDefaults, ...exportOptions.env };
  env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
  for (const signal of OTLP_SIGNALS) {
    const name = `OTEL_${signal.toUpperCase()}_EXPORTER`;
    if (endpoints[signal] === undefined && (env[name] ?? "").trim() === "") env[name] = "none";
  }
  return env;
}
