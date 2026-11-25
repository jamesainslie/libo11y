/**
 * WP5 (webext). One consent state for the whole extension, in chrome.storage.local.
 */
import type { ConsentController, ConsentState } from "@libo11y/web/internal";
import { diag } from "@opentelemetry/api";
import type { ChromeLike, StorageChangeLike } from "./chrome.ts";

/** The chrome.storage.local key. */
export const CONSENT_STORAGE_KEY = "libo11y.consent";

function isConsentState(v: unknown): v is ConsentState {
  return v === "pending" || v === "granted" || v === "denied";
}

/** The stored state, or undefined when none is stored, storage is unavailable or the value is malformed. */
export async function readStoredConsent(chrome: ChromeLike): Promise<ConsentState | undefined> {
  if (chrome.storage === undefined) return undefined;
  try {
    const items = await chrome.storage.local.get(CONSENT_STORAGE_KEY);
    const value = items[CONSENT_STORAGE_KEY];
    return isConsentState(value) ? value : undefined;
  } catch (err) {
    diag.warn("o11y: reading the stored consent", err);
    return undefined;
  }
}

/** A running sync between a controller and storage. */
export interface ConsentSync {
  /** Stops syncing both ways. Idempotent. */
  readonly stop: () => void;
  /**
   * Re-reads the stored state and applies it now, resolving once applied. For a decision that
   * must not wait for storage.onChanged, such as accepting a batch just after a grant elsewhere.
   */
  readonly refresh: () => Promise<void>;
}

/**
 * Keeps controller and storage in step: every controller change is written, and a storage change
 * from another context is applied with grant() or revoke() when it differs (so a revoke anywhere
 * clears this context's queues). Returns the running sync.
 *
 * A storage change is a signal to re-read the stored state rather than a value to apply, because
 * storage operations run in order: the echo of an earlier write of this context can arrive after a
 * later change here, and the re-read then returns the later state. "pending" is never applied,
 * because consent has no way back to it. The stored state is also read once at the start, to
 * catch a change between readStoredConsent and this call.
 *
 * Privacy signals deny everywhere: when a stored "granted" cannot be applied because this
 * controller respects a privacy signal (DNT or GPC) that is set, "denied" is written back, and
 * every other context then revokes. So a grant in a content script, whose controller reads no
 * signals, is undone extension-wide when the worker's signals refuse it, as is a stored grant the
 * worker finds when it wakes.
 */
export function syncConsent(controller: ConsentController, chrome: ChromeLike): ConsentSync {
  const storage = chrome.storage;
  if (storage === undefined) return { stop: () => {}, refresh: async () => {} };
  let stopped = false;
  let applying = false;

  const write = (state: ConsentState): void => {
    storage.local.set({ [CONSENT_STORAGE_KEY]: state }).catch((err: unknown) => {
      diag.warn("o11y: storing the consent state", err);
    });
  };
  const apply = (stored: ConsentState | undefined): void => {
    if (stopped || stored === undefined || stored === "pending") return;
    const consent = controller.consent;
    if (stored === consent.state()) return;
    applying = true;
    try {
      if (stored === "granted") consent.grant();
      else void consent.revoke();
    } finally {
      applying = false;
    }
    // A respected privacy signal refused the grant: store the refusal, so every context denies.
    if (stored === "granted" && consent.state() !== "granted") write(consent.state());
  };
  const refresh = (): Promise<void> =>
    readStoredConsent(chrome)
      .then(apply)
      .catch((err: unknown) => {
        diag.warn("o11y: applying the stored consent", err);
      });
  const reconcile = (): void => {
    void refresh();
  };

  const unsubscribe = controller.consent.subscribe((state) => {
    if (stopped || applying) return;
    write(state);
  });
  const onChanged = (changes: Record<string, StorageChangeLike>, areaName: string): void => {
    if (areaName !== "local" || !Object.hasOwn(changes, CONSENT_STORAGE_KEY)) return;
    reconcile();
  };
  storage.onChanged.addListener(onChanged);
  reconcile();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    storage.onChanged.removeListener(onChanged);
  };
  return { stop, refresh };
}
