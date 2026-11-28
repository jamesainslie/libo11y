/**
 * The consent gate. Consent is the public face (telemetry.consent). ConsentController is what the
 * platforms wire: core reads it as the RecordingGate, the Delivery reads it before every send, and
 * revocation runs the hooks that clear every queue.
 */
import type { RecordingGate } from "@libo11y/core";

/**
 * pending: no decision yet. granted: record and send. denied: the user said no, or a respected
 * privacy signal (DNT, GPC) said no. In pending and denied nothing is recorded, buffered or sent.
 */
export type ConsentState = "pending" | "granted" | "denied";

/** Options for the consent gate. */
export interface ConsentOptions {
  /**
   * The state at setup. Default "pending", so nothing is recorded until the application calls
   * grant(). Pass "granted" where no consent is needed, such as internal tools.
   */
  readonly initial?: ConsentState;
  /** Treat navigator.doNotTrack === "1" as denied: the state starts denied and grant() is refused. Default false. */
  readonly respectDoNotTrack?: boolean;
  /** Treat navigator.globalPrivacyControl === true as denied, as respectDoNotTrack. Default false. */
  readonly respectGlobalPrivacyControl?: boolean;
}

/** The application's handle on consent. */
export interface Consent {
  state(): ConsentState;
  /**
   * Starts recording, unless a respected privacy signal is set. Returns the state after the call:
   * "granted", or "denied" when a signal refused it.
   */
  grant(): ConsentState;
  /**
   * Stops recording at once (the state is "denied" before this returns), then clears every queue:
   * the SDK batch buffers drain into a closed gate, and the persistent queue is emptied. The promise
   * resolves when the queues are clear and never rejects. A request already on the wire is not
   * recalled.
   */
  revoke(): Promise<void>;
  /** Calls listener after every state change. Returns a function that unsubscribes. */
  subscribe(listener: (state: ConsentState) => void): () => void;
}

/** The consent gate as the platforms wire it. recording() is state() === "granted". */
export interface ConsentController extends RecordingGate {
  readonly consent: Consent;
  /**
   * Registers work revoke() waits for, run in registration order after the state changes. A hook
   * that throws or rejects is reported through diag and the rest still run. Returns a function that
   * unregisters it.
   */
  onRevoke(hook: () => void | Promise<void>): () => void;
}

/** The navigator fields the privacy signals read. */
export interface PrivacySignalSource {
  readonly doNotTrack?: string | null;
  readonly globalPrivacyControl?: boolean;
}

/** Options for createConsentController. */
export interface ConsentControllerOptions extends ConsentOptions {
  /** Where DNT and GPC are read. Default globalThis.navigator. */
  readonly navigator?: PrivacySignalSource;
}
