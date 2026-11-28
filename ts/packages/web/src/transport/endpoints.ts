/**
 * The OTLP URL of each signal.
 */
import { diag } from "@opentelemetry/api";
import { OTLP_SIGNALS, type OtlpSignal } from "../contracts/otlp.ts";
import type { BrowserExportOptions } from "../options.ts";

/** The OTLP URL of each signal, or undefined when the signal has none and is off. */
export type SignalEndpoints = Readonly<Record<OtlpSignal, string | undefined>>;

const SIGNAL_OPTION = {
  traces: "tracesEndpoint",
  metrics: "metricsEndpoint",
  logs: "logsEndpoint",
} as const satisfies Record<OtlpSignal, keyof BrowserExportOptions>;

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v === undefined || v === "" ? undefined : v;
}

function join(base: string, signal: OtlpSignal): string {
  return `${base}${base.endsWith("/") ? "" : "/"}v1/${signal}`;
}

function pageHref(): string | undefined {
  return (globalThis as { location?: { href?: string } }).location?.href;
}

/**
 * Resolves each signal's URL from the per-signal option, the endpoint option joined with
 * "v1/<signal>", env OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT, then env OTEL_EXPORTER_OTLP_ENDPOINT
 * joined the same way. Per-signal URLs are used as is. Joining adds a "/" when
 * the base lacks one. Relative URLs resolve against base (default globalThis.location?.href); a URL
 * that cannot be parsed makes that signal undefined and is reported through diag. env is skipped
 * when hermetic is true.
 */
export function resolveEndpoints(
  opts: BrowserExportOptions,
  hermetic: boolean,
  base: string | undefined = pageHref(),
): SignalEndpoints {
  const env = hermetic ? {} : (opts.env ?? {});
  const resolve = (signal: OtlpSignal): string | undefined => {
    const general = nonEmpty(opts.endpoint);
    const envGeneral = nonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT);
    const raw =
      nonEmpty(opts[SIGNAL_OPTION[signal]]) ??
      (general === undefined ? undefined : join(general, signal)) ??
      nonEmpty(env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`]) ??
      (envGeneral === undefined ? undefined : join(envGeneral, signal));
    if (raw === undefined) return undefined;
    try {
      return new URL(raw, base).href;
    } catch {
      diag.warn(`libo11y: the OTLP ${signal} endpoint is not a URL; ${signal} are not exported`);
      return undefined;
    }
  };
  const out = {} as Record<OtlpSignal, string | undefined>;
  for (const signal of OTLP_SIGNALS) out[signal] = resolve(signal);
  return out;
}
