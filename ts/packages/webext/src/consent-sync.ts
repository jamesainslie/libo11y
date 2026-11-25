/**
 * WP5 (webext). One consent state for the whole extension, in chrome.storage.local.
 */
import type { ConsentController, ConsentState } from "@libo11y/web/internal";
import type { ChromeLike } from "./chrome.ts";

/** The chrome.storage.local key. */
export const CONSENT_STORAGE_KEY = "libo11y.consent";

/** The stored state, or undefined when none is stored, storage is unavailable or the value is malformed. */
export function readStoredConsent(chrome: ChromeLike): Promise<ConsentState | undefined> {
  void chrome;
  throw new Error("not implemented");
}

/**
 * Keeps controller and storage in step: every controller change is written, and a storage change
 * from another context is applied with grant() or revoke() when it differs (so a revoke anywhere
 * clears this context's queues). Returns a function that stops syncing.
 */
export function syncConsent(controller: ConsentController, chrome: ChromeLike): () => void {
  void controller;
  void chrome;
  throw new Error("not implemented");
}
