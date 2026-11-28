/**
 * The app lifecycle from AppState: background, and inactive on iOS (the app switcher, an incoming
 * call, Control Center), hide the app; active, or any other state, shows it. Listeners run in
 * registration order, once per change between visible and hidden. AppState is listened to only
 * while someone subscribes, so the lifecycle needs no close.
 */
import { diag } from "@opentelemetry/api";
import type { AppLifecycle, AppStateLike } from "./contracts/env.ts";

const HIDDEN: ReadonlySet<string> = new Set(["background", "inactive"]);

const isVisible = (state: string | null | undefined): boolean => !HIDDEN.has(state ?? "active");

/** An AppLifecycle over appState. */
export function appStateLifecycle(appState: AppStateLike): AppLifecycle {
  const listeners: ((visible: boolean) => void)[] = [];
  let sub: { remove(): void } | undefined;
  // What the listeners last heard, so repeated states and active to active call nothing.
  let notified = isVisible(appState.currentState);
  const onChange = (state: string): void => {
    const next = isVisible(state);
    if (next === notified) return;
    notified = next;
    for (const l of [...listeners]) {
      try {
        l(next);
      } catch (err) {
        diag.warn("libo11y: react-native: a lifecycle listener threw", err);
      }
    }
  };
  return {
    visible: () => isVisible(appState.currentState),
    subscribe(l) {
      if (sub === undefined) {
        notified = isVisible(appState.currentState);
        sub = appState.addEventListener("change", onChange);
      }
      listeners.push(l);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.splice(listeners.indexOf(l), 1);
        if (listeners.length === 0) {
          sub?.remove();
          sub = undefined;
        }
      };
    },
  };
}
