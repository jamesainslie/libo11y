/**
 * Contract, frozen by the L4 scaffold. Changing it needs the architect's sign-off, because WP1, WP2,
 * WP3 and WP5 all build against it.
 *
 * One serialized OTLP/HTTP JSON export request: the unit the transport sends, the queue stores and
 * the webext messaging protocol carries.
 */

/** An OTLP signal, which also names its HTTP path: /v1/traces, /v1/metrics, /v1/logs. */
export type OtlpSignal = "traces" | "metrics" | "logs";

/** The signals in a fixed order, for iteration. */
export const OTLP_SIGNALS: readonly OtlpSignal[] = ["traces", "metrics", "logs"];

/** One OTLP/HTTP JSON request body for one signal. */
export interface OtlpBatch {
  readonly signal: OtlpSignal;
  /**
   * The ExportTraceServiceRequest, ExportMetricsServiceRequest or ExportLogsServiceRequest as OTLP
   * JSON text, uncompressed. A string rather than bytes, because IndexedDB and extension messaging
   * both carry strings without copying surprises, and Chrome serializes runtime messages as JSON.
   */
  readonly body: string;
}
