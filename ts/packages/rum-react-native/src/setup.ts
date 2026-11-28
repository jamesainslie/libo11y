/**
 * setupRumReactNativeWith: the RUM core (`@libo11y/rum/core`) bound to React Native. The platform is
 * `@libo11y/react-native`'s setup through reactNativeBinding, the lifecycle its AppState, and every
 * view a screen. Device storage (options.storage, default memoryStorage()) holds the retry queue,
 * the retention buffer of sessions not yet kept, the session, so a relaunch within the idle window
 * continues it, and the remote configuration cache. None of it is read or written before consent
 * is granted. The app_load span is recorded once per process (app-start.ts). setupRumReactNative,
 * in index.ts, passes the real dependencies from env.ts.
 */
import { memoryStorage, openStorageQueue, type ReactNativeDeps } from "@libo11y/react-native/internal";
import { CONFIG_STORAGE_KEY, setupRumCore } from "@libo11y/rum/core";
import { RUM_PLATFORM_VALUE_REACT_NATIVE } from "@libo11y/spec";
import { createAppStart } from "./app-start.ts";
import { reactNativeBinding, rumLifecycle } from "./binding.ts";
import { preloadedStorage } from "./config-cache.ts";
import type { RumReactNativeEnv } from "./contracts/env.ts";
import type { ReactNativeRumTelemetry, RumReactNativeSetupOptions } from "./options.ts";
import { storageSessionStore } from "./session-store.ts";

/** The fixed URL RUM's core reads where a page has its location: an app has none. */
export const APP_LOCATION = "app:///";

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
  const appStart = createAppStart({ env: deps.env });
  const t = await setupRumCore(
    { ...platformOptions, storage },
    { ...core, viewName: () => initialViewName },
    {
      platform: RUM_PLATFORM_VALUE_REACT_NATIVE,
      bind: reactNativeBinding(deps.platform, install, deps.fetch),
      lifecycle: rumLifecycle(deps.platform.lifecycle),
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
      onRuntime: (rt) => appStart.attach(rt),
    },
  );
  const shutdown = t.shutdown.bind(t);
  t.shutdown = (opts) => {
    appStart.close();
    return shutdown(opts);
  };
  return t;
}
