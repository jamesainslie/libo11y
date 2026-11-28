/**
 * The React Native binding of the RUM core (R5d): setupRumCore hands it the setup options with
 * RUM's span processor, context manager and forwarding span exporter in place, and the wrappers;
 * it runs `@libo11y/react-native`'s setupReactNativeWith over deps with each wrapper applied. The
 * lifecycle is the app's AppState: background, and inactive on iOS, hide the app; active shows it.
 */
import type { ReactNativeSetupOptions, ReactNativeTelemetry } from "@libo11y/react-native";
import {
  type AppLifecycle,
  type ReactNativeDeps,
  setupReactNativeWith,
} from "@libo11y/react-native/internal";
import type { RumBind, RumLifecycle } from "@libo11y/rum/core";

/** A binding of React Native: its setup options and telemetry. */
export type ReactNativeRumBind = RumBind<ReactNativeSetupOptions, ReactNativeTelemetry>;

/**
 * The React Native binding: setupReactNativeWith over deps with RUM's wrappers, installing globally
 * when install is true. fetch, when given, is the fetch the OTLP transport sends with instead of
 * the pristine global fetch, as in tests.
 */
export function reactNativeBinding(
  deps: ReactNativeDeps,
  install: boolean,
  fetch?: typeof globalThis.fetch,
): ReactNativeRumBind {
  return (options, w) =>
    setupReactNativeWith(
      options,
      {
        ...deps,
        createConsentController: (o) => w.consentController(deps.createConsentController(o)),
        createHttpTransport: (o) =>
          deps.createHttpTransport(w.transportOptions(fetch === undefined ? o : { ...o, fetch })),
        // Traces are injected, so the platform's span exporter goes unused; logs are routed by
        // session. The gateway accepts only delta sums and histograms, so app metrics export with
        // delta temporality.
        createExporterSet: (req, d, endpoints, eo) =>
          w.exporterSet(deps.createExporterSet(req, d, endpoints, { ...eo, metricTemporality: "delta" })),
        installNetworkInstrumentation: (o) =>
          deps.installNetworkInstrumentation({ ...o, onStart: w.onRequestStart }),
        onPlatform: (platform, info) => {
          w.platform({ delivery: info.delivery, endpoints: info.endpoints }, info.env);
          deps.onPlatform?.(platform, info);
        },
      },
      install,
    );
}

/**
 * RUM's lifecycle over the app's: hide on going to the background, show on coming back. RUM
 * subscribes before the binding runs the platform's setup, so on a hide the summaries are emitted
 * before the platform's own listener flushes them. No restore: an app has no back/forward cache.
 * No activity yet: coming back to the foreground touches the session, and touches will once the
 * touch boundary records them.
 */
export function rumLifecycle(app: AppLifecycle): RumLifecycle {
  return {
    visible: () => app.visible(),
    subscribe: (h) => app.subscribe((visible) => (visible ? h.show() : h.hide())),
  };
}
