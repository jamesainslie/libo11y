/**
 * WP2 (queue and consent). Do Not Track and Global Privacy Control.
 */
import type { ConsentOptions, PrivacySignalSource } from "../contracts/consent.ts";

/**
 * True when a privacy signal the options respect is set: navigator.doNotTrack === "1" with
 * respectDoNotTrack, navigator.globalPrivacyControl === true with respectGlobalPrivacyControl.
 */
export function privacySignalDenies(opts: ConsentOptions, nav: PrivacySignalSource | undefined): boolean {
  void opts;
  void nav;
  throw new Error("not implemented");
}
