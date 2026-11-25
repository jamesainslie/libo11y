/**
 * WP2 (queue and consent). The recording gate in core: the sampler wrapper the tracer provider
 * uses, and the check the meter and log pipelines share. telemetry.ts, metrics.ts and logger.ts call
 * these; only WP2 edits those files in L4.
 */
import type { Sampler } from "@opentelemetry/sdk-trace";
import type { RecordingGate } from "./platform.ts";

/**
 * A sampler that returns NOT_RECORD while the gate is closed and asks inner otherwise. toString
 * is inner's, so the startup summary reports the configured sampler.
 */
export function gatedSampler(inner: Sampler, gate: RecordingGate): Sampler {
  void inner;
  void gate;
  throw new Error("not implemented");
}

/** True when there is no gate or the gate is open. */
export function gateOpen(gate: RecordingGate | undefined): boolean {
  return gate === undefined || gate.recording();
}
