/**
 * The web's platform binding and lifecycle. setupRumCore builds the RUM core, then hands
 * a binding the setup options with RUM's span processor, context manager and forwarding span
 * exporter in place, and the wrappers (contracts/binding.ts). webBinding runs web's setupWithDeps
 * with them; @libo11y/rum/webext's contentBinding runs @libo11y/webext's setupContentScriptWith.
 */
import type { WebSetupOptions, WebTelemetry } from "@libo11y/web";
import { browserEnv, type SetupDeps, setupWithDeps } from "@libo11y/web/internal";
import type { RumBind, RumLifecycle } from "./contracts/binding.ts";

export type { RumWrappers } from "./contracts/binding.ts";

/** A binding of browser contexts: web's setup options and telemetry. */
export type WebRumBind = RumBind<WebSetupOptions, WebTelemetry>;

/** The web binding: setupWithDeps over deps with RUM's wrappers, installing globally when install is true. */
export function webBinding(deps: SetupDeps, install: boolean): WebRumBind {
  return (options, w) =>
    setupWithDeps(
      options,
      {
        ...deps,
        createConsentController: (o) => w.consentController(deps.createConsentController(o)),
        createHttpTransport: (o) => deps.createHttpTransport(w.transportOptions(o)),
        onPlatform: (platform, po) => {
          w.platform(po, browserEnv(options, po.endpoints));
          deps.onPlatform?.(platform, po);
        },
        // Traces are injected, so web builds no span exporter here; logs are routed by session. The
        // gateway accepts only delta sums and histograms, so app metrics export with delta temporality.
        createExporterSet: (req, d, endpoints, eo) =>
          w.exporterSet(deps.createExporterSet(req, d, endpoints, { ...eo, metricTemporality: "delta" })),
        installFetchInstrumentation: (o) =>
          deps.installFetchInstrumentation({ ...o, onStart: w.onRequestStart }),
        installXhrInstrumentation: (o) => deps.installXhrInstrumentation({ ...o, onStart: w.onRequestStart }),
      },
      install,
    );
}

/** User activity that keeps the session alive. */
const ACTIVITY = ["pointerdown", "keydown", "scroll", "touchstart"] as const;

/**
 * A page's lifecycle: hide on visibilitychange to hidden and on pagehide (a navigation signals
 * both, pagehide first), show on visibilitychange to visible, and restore on the pageshow of a page
 * restored from the back/forward cache; the pageshow of a load that finished in a background tab
 * is not one. Activity is pointerdown, keydown, scroll and touchstart on window, captured.
 */
export function webLifecycle(
  doc: (EventTarget & { readonly visibilityState?: string }) | undefined,
  win: EventTarget | undefined,
): RumLifecycle {
  const hidden = (): boolean => doc?.visibilityState === "hidden";
  return {
    visible: () => !hidden(),
    subscribe(h) {
      const onVisibility = (): void => (hidden() ? h.hide() : h.show());
      const onPageShow = (e: Event): void => {
        if ((e as Event & { persisted?: boolean }).persisted === true) h.restore();
      };
      doc?.addEventListener("visibilitychange", onVisibility);
      win?.addEventListener("pagehide", h.hide);
      win?.addEventListener("pageshow", onPageShow);
      return () => {
        doc?.removeEventListener("visibilitychange", onVisibility);
        win?.removeEventListener("pagehide", h.hide);
        win?.removeEventListener("pageshow", onPageShow);
      };
    },
    activity(listener) {
      for (const a of ACTIVITY) win?.addEventListener(a, listener, { capture: true, passive: true });
      return () => {
        for (const a of ACTIVITY) win?.removeEventListener(a, listener, { capture: true });
      };
    },
  };
}
