/**
 * setupRum: @libo11y/web's setup with RUM wired in. setupRumWith binds the RUM core
 * (core-setup.ts) to the web: web's setupWithDeps through webBinding, the page's lifecycle from
 * visibilitychange, pagehide and pageshow, remote configuration cached in localStorage, and the
 * bootstrap buffer replayed. The extension contexts pass their own binding and stores in deps.
 */
import type { RUMPlatform } from "@libo11y/spec";
import type { WebSetupOptions, WebTelemetry } from "@libo11y/web";
import { defaultSetupDeps, openQueue, type SetupDeps } from "@libo11y/web/internal";
import { webBinding, webLifecycle } from "./bind.ts";
import { takeBootstrap } from "./bootstrap/buffer.ts";
import { replayBootstrap } from "./bootstrap/replay.ts";
import type { RumBind, RumLifecycle } from "./contracts/binding.ts";
import { type RumCoreDeps, setupRumCore } from "./core-setup.ts";
import type { RumSetupOptions, RumTelemetry } from "./options.ts";
import { localStorageSessionStore } from "./session/local-store.ts";

export { runtimeOf, SESSION_END_ELECTION_MILLIS } from "./core-setup.ts";

/** What setupRumWith builds on. Internal: tests and the extension wiring replace parts of it. */
export interface RumDeps
  extends Omit<
    RumCoreDeps<WebSetupOptions, WebTelemetry>,
    "platform" | "bind" | "lifecycle" | "window" | "bootstrap" | "storage"
  > {
  readonly web: SetupDeps;
  readonly document: (EventTarget & { readonly visibilityState?: string }) | undefined;
  readonly window: EventTarget | undefined;
  /** Install the telemetry globally, as setup does. Default true; tests that run two tabs in one process pass false. */
  readonly install?: boolean;
  /** The platform summaries, session starts and app_load record. Default "web". */
  readonly platform?: RUMPlatform;
  /** Runs the platform's setup with RUM's wrappers. Default webBinding(web, install). */
  readonly bind?: RumBind<WebSetupOptions, WebTelemetry>;
  /** Default webLifecycle(document, window). */
  readonly lifecycle?: RumLifecycle;
  /**
   * Where remote configuration is cached. Default localStorage. Called only once consent is granted.
   * It may resolve later, as a cache in chrome.storage.local does once it has read the stored value.
   */
  readonly storage?: RumCoreDeps<WebSetupOptions, WebTelemetry>["storage"];
}

/** The real dependencies of a page. */
export function defaultRumDeps(): RumDeps {
  const g = globalThis as {
    document?: EventTarget & { visibilityState?: string; prerendering?: boolean };
    location?: { href: string };
    navigator?: { connection?: { effectiveType?: string } };
  };
  const web = defaultSetupDeps();
  return {
    web,
    openRetentionQueue: openQueue,
    sessionStore: () => localStorageSessionStore(),
    now: Date.now,
    perfNow: () => performance.now(),
    timeOrigin: performance.timeOrigin,
    location: () => g.location?.href ?? "about:blank",
    prerendered: () => {
      if (g.document?.prerendering === true) return true;
      const nav = performance.getEntriesByType?.("navigation")[0] as { activationStart?: number } | undefined;
      return (nav?.activationStart ?? 0) > 0;
    },
    connection: () => g.navigator?.connection?.effectiveType,
    document: g.document,
    window: web.window,
  };
}

/** Builds browser telemetry with RUM and installs it globally, as the setup of `@libo11y/web` does. */
export function setupRum(options: RumSetupOptions = {}): Promise<RumTelemetry> {
  return setupRumWith(options, defaultRumDeps());
}

/** setupRum over deps. Internal: the seam the unit tests and the extension wiring use. */
export function setupRumWith(options: RumSetupOptions, deps: RumDeps): Promise<RumTelemetry> {
  const { rum, ...webOptions } = options;
  return setupRumCore(webOptions, rum, {
    ...deps,
    platform: deps.platform ?? "web",
    bind: deps.bind ?? webBinding(deps.web, deps.install !== false),
    lifecycle: deps.lifecycle ?? webLifecycle(deps.document, deps.window),
    storage: deps.storage ?? (() => globalThis.localStorage),
    bootstrap: () => {
      const early = takeBootstrap();
      return (runtime) => replayBootstrap(runtime, early);
    },
  });
}
