/**
 * WP2 (queue and consent). The consent gate.
 */
import type { ConsentController, ConsentControllerOptions } from "../contracts/consent.ts";

/**
 * Builds the gate. The state starts at opts.initial (default "pending"), or "denied" when
 * privacySignalDenies. grant() moves to "granted" unless a respected signal is set; revoke() moves
 * to "denied", notifies, then runs the revoke hooks in order. Subscribers (both consent.subscribe
 * and the RecordingGate subscribe) are called only on a real change, synchronously, in
 * registration order; a throwing subscriber is reported through diag.
 */
export function createConsentController(opts?: ConsentControllerOptions): ConsentController {
  void opts;
  throw new Error("not implemented");
}
