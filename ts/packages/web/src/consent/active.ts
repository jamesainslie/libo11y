/**
 * Scaffold, implemented. Owned by WP3 (setup sets it); read by WP4 (instrumentation).
 *
 * The consent of the telemetry setup installed, for instrumentation built without an explicit
 * telemetry. Undefined when no web setup is active, and then instrumentation records as the
 * globals allow.
 */
import type { Consent } from "../contracts/consent.ts";

let active: Consent | undefined;

/** Records the consent of the global telemetry; setup sets it and shutdown clears it. */
export function setActiveConsent(consent: Consent | undefined): void {
  active = consent;
}

/** The consent of the global telemetry, if a web setup is active. */
export function activeConsent(): Consent | undefined {
  return active;
}
