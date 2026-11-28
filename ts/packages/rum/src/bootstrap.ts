/**
 * `@libo11y/rum/bootstrap`: the first part of the two-part loader. It is tiny and imports nothing
 * from OpenTelemetry or the rest of libo11y, so it can go in the app's entry chunk:
 *
 *   import { afterLoad, installRumBootstrap } from "@libo11y/rum/bootstrap";
 *   installRumBootstrap({ consent: knownConsent });
 *   afterLoad(() => import("./rum.ts"));
 *
 * With consent "granted" it holds early errors, rejections, CSP violations and clicks in memory
 * until setupRum replays them; with "pending", the default, it records nothing at all.
 */
import { afterLoadOn, installRumBootstrapOn, type RumBootstrapOptions } from "./bootstrap/buffer.ts";

export type { RumBootstrapOptions } from "./bootstrap/buffer.ts";

/** Starts buffering early errors, rejections, CSP violations and clicks in memory, for at most 30 s. */
export function installRumBootstrap(opts: RumBootstrapOptions = {}): void {
  installRumBootstrapOn(globalThis, opts, {
    now: () => performance.now(),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
  });
}

/** Runs load once the page's load event has fired (now, if it has), in an idle callback where available. */
export function afterLoad(load: () => void): void {
  const g = globalThis as typeof globalThis & {
    document?: { readyState?: string };
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  afterLoadOn(
    {
      ...(g.document === undefined ? {} : { document: g.document }),
      ...(typeof g.addEventListener === "function" ? { window: g } : {}),
      idle: (cb) => {
        if (typeof g.requestIdleCallback === "function") g.requestIdleCallback(cb, { timeout: 2000 });
        else setTimeout(cb, 0);
      },
    },
    load,
  );
}
