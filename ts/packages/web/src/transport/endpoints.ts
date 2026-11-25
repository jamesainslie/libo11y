/**
 * WP1 (transport). The OTLP URL of each signal.
 */
import type { OtlpSignal } from "../contracts/otlp.ts";
import type { BrowserExportOptions } from "../options.ts";

/** The OTLP URL of each signal, or undefined when the signal has none and is off. */
export type SignalEndpoints = Readonly<Record<OtlpSignal, string | undefined>>;

/**
 * Resolves each signal's URL in this order: the per-signal option (tracesEndpoint, ...) as is, then
 * env OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT as is, then the endpoint option joined with
 * "v1/<signal>", then env OTEL_EXPORTER_OTLP_ENDPOINT joined the same way. Joining adds a "/" when
 * the base lacks one. Relative URLs resolve against base (default globalThis.location?.href); a URL
 * that cannot be parsed makes that signal undefined and is reported through diag. env is skipped
 * when hermetic is true.
 */
export function resolveEndpoints(
  opts: BrowserExportOptions,
  hermetic: boolean,
  base?: string,
): SignalEndpoints {
  void opts;
  void hermetic;
  void base;
  throw new Error("not implemented");
}
