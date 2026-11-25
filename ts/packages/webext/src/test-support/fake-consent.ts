/**
 * WP5. A ConsentController with the contract's semantics (subscribers on change only, in order;
 * revoke awaits the hooks in order), counting its grant and revoke calls, so webext tests run
 * before WP2's controller exists. Tests only; never built.
 */
import type { ConsentController, ConsentState } from "@libo11y/web/internal";

export interface FakeConsentController extends ConsentController {
  readonly calls: { grant: number; revoke: number };
}

export function createFakeConsentController(initial: ConsentState = "pending"): FakeConsentController {
  let state = initial;
  const listeners = new Set<(state: ConsentState) => void>();
  const gateListeners = new Set<(recording: boolean) => void>();
  const hooks: (() => void | Promise<void>)[] = [];
  const calls = { grant: 0, revoke: 0 };
  const change = (next: ConsentState) => {
    if (next === state) return;
    const was = state === "granted";
    state = next;
    for (const l of [...listeners]) l(state);
    if (was !== (state === "granted")) for (const l of [...gateListeners]) l(state === "granted");
  };
  return {
    calls,
    consent: {
      state: () => state,
      grant() {
        calls.grant++;
        change("granted");
        return state;
      },
      async revoke() {
        calls.revoke++;
        change("denied");
        for (const h of [...hooks]) {
          try {
            await h();
          } catch {
            // Isolated, as the contract says.
          }
        }
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    recording: () => state === "granted",
    subscribe(listener) {
      gateListeners.add(listener);
      return () => gateListeners.delete(listener);
    },
    onRevoke(hook) {
      hooks.push(hook);
      return () => {
        const i = hooks.indexOf(hook);
        if (i >= 0) hooks.splice(i, 1);
      };
    },
  };
}
