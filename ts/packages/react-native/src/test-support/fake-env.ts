/** A fake React Native env for tests: AppState with a settable state, and Platform values. Never built. */
import type { AppStateLike, ReactNativeEnv } from "../contracts/env.ts";

export interface FakeEnv extends ReactNativeEnv {
  /** Sets AppState.currentState and calls every change listener with it. */
  setAppState(state: string): void;
  /** How many AppState change listeners are registered. */
  listeners(): number;
}

export function fakeEnv(over: Partial<ReactNativeEnv> = {}): FakeEnv {
  const listeners = new Set<(s: string) => void>();
  const appState: AppStateLike & { currentState: string | null } = {
    currentState: "active",
    addEventListener(_type, l) {
      // A Set would merge a listener added twice, so wrap it, as AppState keeps each subscription.
      const own = (s: string): void => l(s);
      listeners.add(own);
      return { remove: () => listeners.delete(own) };
    },
  };
  return {
    appState,
    os: "android",
    isPad: false,
    isTV: false,
    screen: () => ({ width: 411, height: 891 }),
    dev: false,
    ...over,
    setAppState(state) {
      appState.currentState = state;
      for (const l of [...listeners]) l(state);
    },
    listeners: () => listeners.size,
  };
}
