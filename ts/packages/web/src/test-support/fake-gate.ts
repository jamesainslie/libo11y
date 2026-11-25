/**
 * Scaffold, frozen. A settable RecordingGate for tests. Tests only; never built.
 */
import type { RecordingGate } from "@libo11y/core";

/** A RecordingGate whose state the test sets. */
export interface FakeGate extends RecordingGate {
  set(open: boolean): void;
}

/** A gate, open unless open is false. */
export function createFakeGate(open = true): FakeGate {
  let state = open;
  const listeners = new Set<(recording: boolean) => void>();
  return {
    recording: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      if (next === state) return;
      state = next;
      for (const l of [...listeners]) l(state);
    },
  };
}
