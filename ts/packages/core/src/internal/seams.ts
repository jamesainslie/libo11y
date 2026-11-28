/**
 * Test-only seams, as Go's export_test.go has them. Not part of the public API: only core's own
 * tests and @libo11y/test set them, and they are read when a Telemetry is created.
 */

/** Seams a test may set before createTelemetryWith. */
export const seams: {
  baggageEgress: ((key: string) => boolean) | undefined;
  now: (() => number) | undefined;
} = {
  /** The baggage egress predicate. Undefined means allow every key. */
  baggageEgress: undefined,
  /** The clock the rate limits on o11y.telemetry.dropped read. Undefined means Date.now. */
  now: undefined,
};
