/**
 * errors() on React Native (decision N12). ErrorUtils' global handler is chained: every error it
 * sees is recorded with source uncaught (the spec keeps crash for native crashes), and the handler
 * that was installed before runs with the same arguments. A fatal error ends the app in release
 * once React Native's handler runs, so before handing it on the view summaries are sent and the
 * telemetry is flushed for at most fatalFlushMillis; the persist-first delivery has then stored or
 * sent the error. Unhandled promise rejections come from Hermes's rejection tracker, by default in
 * release builds only, which leaves React Native's LogBox warning in development. Failed requests
 * are network errors and, with console on, console.error calls are console errors, as on the web.
 * An error raised while one is being recorded is handed on without being recorded again. Stop
 * restores the previous handler while ours is installed; when another handler was chained over
 * ours, ours stays in its chain and only hands on. The Hermes tracker cannot be removed, so stop
 * mutes it.
 */
import {
  createErrorRecorder,
  type RumCollector,
  watchConsoleErrors,
  watchNetworkErrors,
} from "@libo11y/rum/core";
import { diag } from "@opentelemetry/api";
import type { RumReactNativeEnv } from "../contracts/env.ts";
import { installRejectionTracker } from "./rejections.ts";

/** The options of errors() on React Native. */
export interface RnErrorsOptions {
  /** Capture console.error calls as errors with source console. Default false. */
  readonly console?: boolean;
  /**
   * Track unhandled promise rejections with Hermes's tracker: in release builds only (default),
   * always, or never. "always" replaces React Native's development warning with one console.warn
   * line per rejection.
   */
  readonly unhandledRejections?: "release" | "always" | "never";
  /** How long a fatal error waits for the flush before React Native's handler runs. Default 2000. */
  readonly fatalFlushMillis?: number;
}

/** What errors() reads from the runtime. */
export type RnErrorsEnv = Pick<
  RumReactNativeEnv,
  "setTimeout" | "clearTimeout" | "dev" | "errorUtils" | "hermes" | "console"
>;

/** The default of RnErrorsOptions.fatalFlushMillis. */
export const FATAL_FLUSH_MILLIS = 2000;

export function errorsWith(env: RnErrorsEnv, opts: RnErrorsOptions = {}): RumCollector {
  const fatalFlushMillis = opts.fatalFlushMillis ?? FATAL_FLUSH_MILLIS;
  const rejections = opts.unhandledRejections ?? "release";
  return {
    name: "errors",
    start(rt) {
      const rec = createErrorRecorder(rt);
      let live = true;
      const stops: (() => void)[] = [() => rec.stop(), watchNetworkErrors(rt, rec)];

      const eu = env.errorUtils;
      if (eu !== undefined) {
        const previous = eu.getGlobalHandler();
        const handOn = (error: unknown, isFatal?: boolean): void => previous(error, isFatal);
        const handler = (error: unknown, isFatal?: boolean): void => {
          if (!live) {
            handOn(error, isFatal);
            return;
          }
          try {
            rec.record("uncaught", error);
          } catch (err) {
            diag.warn("o11y: rum: recording an uncaught error failed", err);
          }
          if (isFatal !== true) {
            handOn(error, isFatal);
            return;
          }
          let done = false;
          let timer: unknown;
          const proceed = (): void => {
            if (done) return;
            done = true;
            if (timer !== undefined) env.clearTimeout(timer);
            handOn(error, isFatal);
          };
          try {
            rt.summary.flush();
            timer = env.setTimeout(proceed, fatalFlushMillis);
            rt.telemetry.forceFlush().then(proceed, proceed);
          } catch (err) {
            diag.warn("o11y: rum: flushing on a fatal error failed", err);
            proceed();
          }
        };
        eu.setGlobalHandler(handler);
        stops.push(() => {
          if (eu.getGlobalHandler() === handler) eu.setGlobalHandler(previous);
        });
      }

      if (rejections === "always" || (rejections === "release" && env.dev !== true)) {
        installRejectionTracker(env.hermes, (reason) => {
          if (!live) return;
          rec.record("unhandled_rejection", reason);
          if (env.dev === true) env.console?.warn("Possible unhandled promise rejection:", reason);
        });
      }

      if (opts.console === true && env.console !== undefined) {
        stops.push(watchConsoleErrors(rt, rec, env.console, (cb, ms) => env.setTimeout(cb, ms)));
      }

      return () => {
        live = false;
        for (const s of stops.reverse()) s();
      };
    },
  };
}
