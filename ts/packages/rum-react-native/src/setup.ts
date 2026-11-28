/**
 * setupRumReactNativeWith: the RUM core (`@libo11y/rum/core`) bound to React Native. The platform is
 * `@libo11y/react-native`'s setup through reactNativeBinding, the lifecycle its AppState, and every
 * view a screen; a new screen is activity. Device storage (options.storage, default memoryStorage()) holds the retry queue,
 * the retention buffer of sessions not yet kept, the session, so a relaunch within the idle window
 * continues it, and the remote configuration cache. RUM writes none of it before consent is
 * granted, and a revoke removes it, also what an earlier launch left. The app_load span is recorded once per process (app-start.ts). setupRumReactNative,
 * in index.ts, passes the real dependencies from env.ts.
 */
import {
  type KeyValueStorage,
  memoryStorage,
  openStorageQueue,
  type ReactNativeDeps,
} from "@libo11y/react-native/internal";
import {
  CONFIG_STORAGE_KEY,
  RETENTION_QUEUE_DEFAULTS,
  SESSION_STORAGE_KEY,
  setupRumCore,
} from "@libo11y/rum/core";
import { RUM_PLATFORM_VALUE_REACT_NATIVE } from "@libo11y/spec";
import { diag } from "@opentelemetry/api";
import { createAppStart } from "./app-start.ts";
import { reactNativeBinding, rumLifecycle } from "./binding.ts";
import { preloadedStorage } from "./config-cache.ts";
import type { RumReactNativeEnv } from "./contracts/env.ts";
import type { ReactNativeRumTelemetry, RumReactNativeSetupOptions } from "./options.ts";
import { storageSessionStore } from "./session-store.ts";

/** The fixed URL RUM's core reads where a page has its location: an app has none. */
export const APP_LOCATION = "app:///";

/** Removes the session, the config cache and the retention buffer an earlier launch stored. Never rejects. */
async function forgetStored(storage: KeyValueStorage, now: () => number): Promise<void> {
  const steps: (() => Promise<unknown>)[] = [
    () => storage.removeItem(SESSION_STORAGE_KEY),
    () => storage.removeItem(CONFIG_STORAGE_KEY),
    async () => {
      const q = await openStorageQueue({ ...RETENTION_QUEUE_DEFAULTS, storage, now });
      try {
        await q.clear();
      } finally {
        await q.close();
      }
    },
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      diag.warn("o11y: rum: removing what an earlier launch stored failed", err);
    }
  }
}

/** What setupRumReactNativeWith builds on. Internal: tests replace parts of it. */
export interface RumReactNativeDeps {
  /** `@libo11y/react-native`'s dependencies, which the binding wraps. */
  readonly platform: ReactNativeDeps;
  readonly env: RumReactNativeEnv;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** performance.now(). */
  readonly perfNow: () => number;
  /** The epoch milliseconds perfNow counts from. */
  readonly timeOrigin: number;
  /**
   * The fetch the OTLP transport and remote configuration use. Default the global fetch captured
   * before the instrumentation patched it.
   */
  readonly fetch?: typeof fetch;
}

/**
 * React Native telemetry with RUM over deps, installing it globally when install is true. Resolves
 * with the platform's telemetry, with rum added.
 */
export async function setupRumReactNativeWith(
  options: RumReactNativeSetupOptions,
  deps: RumReactNativeDeps,
  install: boolean,
): Promise<ReactNativeRumTelemetry> {
  const { rum: rumOptions = {}, ...platformOptions } = options;
  const { initialViewName = "app", ...core } = rumOptions;
  const storage = platformOptions.storage ?? memoryStorage();
  const appStart = createAppStart({ env: deps.env, now: deps.perfNow });
  /** Activity listeners RUM's core registered: a new screen is the user moving through the app. */
  const activity = new Set<() => void>();
  /** Consent was granted in this process, so RUM's core clears what it stored on a revoke. */
  let granted = false;
  const t = await setupRumCore(
    { ...platformOptions, storage },
    { ...core, viewName: () => initialViewName },
    {
      platform: RUM_PLATFORM_VALUE_REACT_NATIVE,
      bind: reactNativeBinding(deps.platform, {
        install,
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        onConsent(c) {
          granted = c.recording();
          c.consent.subscribe((state) => {
            if (state === "granted") granted = true;
          });
          // A launch that never granted has started nothing, so the core removes nothing on a
          // revoke; what an earlier launch stored is removed here.
          c.onRevoke(async () => {
            if (!granted) await forgetStored(storage, deps.now);
          });
        },
      }),
      lifecycle: {
        ...rumLifecycle(deps.platform.lifecycle),
        activity(listener) {
          activity.add(listener);
          return () => activity.delete(listener);
        },
      },
      // The retention buffer claims on deps.now, so its entries are stamped on that clock too.
      openRetentionQueue: (o) => openStorageQueue({ now: deps.now, ...o, storage }),
      sessionStore: () => storageSessionStore(storage),
      now: deps.now,
      perfNow: deps.perfNow,
      timeOrigin: deps.timeOrigin,
      location: () => APP_LOCATION,
      prerendered: () => false,
      connection: () => undefined,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      storage: () => preloadedStorage(storage, [CONFIG_STORAGE_KEY]),
      viewKind: "screen",
      // performance.now() counts from the device's boot on React Native, not from the app's start.
      initialViewStart: () => appStart.start,
      onRuntime: (rt) => appStart.attach(rt),
    },
  );
  // The app start hears of every screen and render, consent or not, and a new screen is activity.
  const rum = t.rum;
  const startView = rum.startView.bind(rum);
  const viewRendered = rum.viewRendered.bind(rum);
  rum.startView = (o) => {
    for (const l of [...activity]) l();
    appStart.screenStarted();
    startView(o);
  };
  rum.viewRendered = () => {
    appStart.rendered(deps.perfNow());
    viewRendered();
  };
  const shutdown = t.shutdown.bind(t);
  t.shutdown = (opts) => {
    appStart.close();
    return shutdown(opts);
  };
  return t;
}
