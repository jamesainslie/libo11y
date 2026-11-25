/**
 * WP2 (queue and consent). Do Not Track and Global Privacy Control.
 */
import type { ConsentOptions, PrivacySignalSource } from "../contracts/consent.ts";

// read returns nav[key], or undefined when the getter throws, as a locked-down navigator may.
function read<K extends keyof PrivacySignalSource>(
  nav: PrivacySignalSource,
  key: K,
): PrivacySignalSource[K] | undefined {
  try {
    return nav[key];
  } catch {
    return undefined;
  }
}

/**
 * True when a privacy signal the options respect is set: navigator.doNotTrack === "1" with
 * respectDoNotTrack, navigator.globalPrivacyControl === true with respectGlobalPrivacyControl.
 */
export function privacySignalDenies(opts: ConsentOptions, nav: PrivacySignalSource | undefined): boolean {
  if (nav === undefined || nav === null) return false;
  if (opts.respectDoNotTrack === true && read(nav, "doNotTrack") === "1") return true;
  if (opts.respectGlobalPrivacyControl === true && read(nav, "globalPrivacyControl") === true) return true;
  return false;
}
