/**
 * WP2 (queue and consent). The consent gate.
 */
import { diag } from "@opentelemetry/api";
import type {
  Consent,
  ConsentController,
  ConsentControllerOptions,
  ConsentState,
  PrivacySignalSource,
} from "../contracts/consent.ts";
import { privacySignalDenies } from "./privacy-signals.ts";

// defaultNavigator is globalThis.navigator, or undefined where the runtime has none.
function defaultNavigator(): PrivacySignalSource | undefined {
  return (globalThis as { navigator?: PrivacySignalSource }).navigator;
}

// notify calls every listener in a snapshot of listeners with value, reporting a throwing one
// through diag so the rest still run.
function notify<T>(listeners: ReadonlySet<(value: T) => void>, value: T, what: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch (err) {
      diag.error(`libo11y: consent ${what} failed`, err);
    }
  }
}

// subscribeTo adds listener to listeners and returns its removal.
function subscribeTo<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void): () => void {
  // A wrapper per subscription, so subscribing one function twice gives two independent entries.
  const entry = (value: T) => listener(value);
  listeners.add(entry);
  return () => {
    listeners.delete(entry);
  };
}

/**
 * Builds the gate. The state starts at opts.initial (default "pending"), or "denied" when
 * privacySignalDenies. grant() moves to "granted" unless a respected signal is set; revoke() moves
 * to "denied", notifies, then runs the revoke hooks in order. Subscribers (both consent.subscribe
 * and the RecordingGate subscribe) are called only on a real change, synchronously, in
 * registration order; a throwing subscriber is reported through diag.
 *
 * The gate is open while the state is "granted" and no revocation is running its hooks. A grant
 * during a revocation changes the state at once, and the consent subscribers hear it, but
 * recording() stays false and the gate subscribers hear true only when the hooks of every
 * revocation in progress have settled, if the state is still "granted" then. So the flush a hook
 * runs always drains into a closed gate, and nothing recorded before the revoke is exported.
 */
export function createConsentController(opts: ConsentControllerOptions = {}): ConsentController {
  const nav = "navigator" in opts ? opts.navigator : defaultNavigator();
  const denies = (): boolean => privacySignalDenies(opts, nav);
  let state: ConsentState = denies() ? "denied" : (opts.initial ?? "pending");
  const stateListeners = new Set<(state: ConsentState) => void>();
  const gateListeners = new Set<(recording: boolean) => void>();
  const hooks = new Set<() => void | Promise<void>>();

  // How many revocations are running their hooks. The gate stays closed while there is one.
  let revoking = 0;
  const open = (): boolean => state === "granted" && revoking === 0;
  // What the gate subscribers last heard, so they hear changes only.
  let gateOpen = open();

  // syncGate tells the gate subscribers when recording() changed.
  const syncGate = (): void => {
    const next = open();
    if (next === gateOpen) return;
    gateOpen = next;
    notify(gateListeners, next, "gate subscriber");
  };

  // move changes the state and notifies: the gate's listeners first, when recording changed, so
  // core stops or starts recording before the application hears of the change.
  const move = (next: ConsentState): void => {
    if (next === state) return;
    state = next;
    syncGate();
    notify(stateListeners, state, "subscriber");
  };

  const consent: Consent = {
    state: () => state,
    grant() {
      move(denies() ? "denied" : "granted");
      return state;
    },
    async revoke() {
      revoking++;
      try {
        move("denied");
        for (const hook of [...hooks]) {
          try {
            await hook();
          } catch (err) {
            diag.error("libo11y: consent revoke hook failed", err);
          }
        }
      } finally {
        // A grant made while the hooks ran opens the gate now, unless another revocation still runs.
        revoking--;
        syncGate();
      }
    },
    subscribe: (listener) => subscribeTo(stateListeners, listener),
  };

  return {
    consent,
    recording: open,
    subscribe: (listener) => subscribeTo(gateListeners, listener),
    onRevoke(hook) {
      const entry = () => hook();
      hooks.add(entry);
      return () => {
        hooks.delete(entry);
      };
    },
  };
}
