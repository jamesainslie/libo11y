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
 */
export function createConsentController(opts: ConsentControllerOptions = {}): ConsentController {
  const nav = "navigator" in opts ? opts.navigator : defaultNavigator();
  const denies = (): boolean => privacySignalDenies(opts, nav);
  let state: ConsentState = denies() ? "denied" : (opts.initial ?? "pending");
  const stateListeners = new Set<(state: ConsentState) => void>();
  const gateListeners = new Set<(recording: boolean) => void>();
  const hooks = new Set<() => void | Promise<void>>();

  // move changes the state and notifies: the gate's listeners first, when recording changed, so
  // core stops or starts recording before the application hears of the change.
  const move = (next: ConsentState): void => {
    if (next === state) return;
    const wasRecording = state === "granted";
    state = next;
    const recording = state === "granted";
    if (recording !== wasRecording) notify(gateListeners, recording, "gate subscriber");
    notify(stateListeners, state, "subscriber");
  };

  const consent: Consent = {
    state: () => state,
    grant() {
      move(denies() ? "denied" : "granted");
      return state;
    },
    async revoke() {
      move("denied");
      for (const hook of [...hooks]) {
        try {
          await hook();
        } catch (err) {
          diag.error("libo11y: consent revoke hook failed", err);
        }
      }
    },
    subscribe: (listener) => subscribeTo(stateListeners, listener),
  };

  return {
    consent,
    recording: () => state === "granted",
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
