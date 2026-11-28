/**
 * errors(): errors the page did not catch, and failed requests.
 *
 * Sources. An error event on window whose target is not an element is uncaught, read from
 * event.error or, when that is null (a cross-origin script error), from event.message. An error
 * event on an element (img, script, link, video, audio, source, iframe), seen in the capture phase,
 * is resource, with the message "<tag> failed to load: <URL without query or fragment>". An
 * unhandledrejection is unhandled_rejection, read from event.reason. A securitypolicyviolation is
 * csp, type CSPViolation, message "<directive> blocked <blocked origin, or inline, eval or the
 * like>". A request that ends without a status is network, type NetworkError, message "<METHOD>
 * <host> failed", unless the app aborted it (error.type AbortError from fetch, abort from XHR). With console on, console.error is console: the arguments rendered (errors by
 * their message, the first error giving the type and stack, else type ConsoleError), and the
 * original console.error always runs. Every error goes through recordError. An error raised while
 * one is being recorded is not recorded again. A runtime scope's error filter (a content script's
 * own scripts) drops every other error, rejection and CSP event. Stop removes the listeners and restores
 * console.error when it is still RUM's wrapper.
 */
import type { BootstrapEntry } from "../bootstrap/buffer.ts";
import type { RumCollector, RumRuntime } from "../contracts/runtime.ts";
import { watchConsoleErrors } from "./console.ts";
import { DescribedError as Described } from "./described.ts";
import { watchNetworkErrors } from "./network.ts";
import { createErrorRecorder } from "./recorder.ts";

export interface ErrorsOptions {
  /** Capture console.error calls as errors with source console. Default false. */
  readonly console?: boolean;
}

/** What errors() needs from the page. Internal: tests inject a fake. */
export interface ErrorsEnv {
  readonly window: EventTarget;
  readonly console?: { error(...args: unknown[]): void };
  /** Defers a console.error that logs an error object. Default the global setTimeout. */
  readonly setTimeout?: (cb: () => void, ms: number) => unknown;
}

function isElement(v: unknown): v is Element {
  return typeof v === "object" && v !== null && typeof (v as Element).tagName === "string";
}

function bare(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.replace(/[?#].*$/, "");
  }
}

function blocked(uri: string): string {
  try {
    const u = new URL(uri);
    return u.origin === "null" ? u.protocol.replace(/:$/, "") : u.origin;
  } catch {
    return uri; // inline, eval, wasm-eval, trusted-types-sink and the like
  }
}

function resourceUrl(el: Element): string {
  const e = el as Element & { currentSrc?: unknown; src?: unknown; href?: unknown };
  for (const v of [e.currentSrc, e.src, e.href, el.getAttribute?.("src"), el.getAttribute?.("href")]) {
    if (typeof v === "string" && v !== "") return bare(v);
  }
  return "";
}

export function errorsWith(opts: ErrorsOptions, env: ErrorsEnv): RumCollector {
  return {
    name: "errors",
    start(rt: RumRuntime) {
      const rec = createErrorRecorder(rt);
      const record = rec.record;
      const stamp = (e: Event): number | undefined =>
        Number.isFinite(e.timeStamp) && e.timeStamp > 0 && e.timeStamp <= rt.now() ? e.timeStamp : undefined;

      // A scope (a content script) limits errors to the events it accepts, such as its own scripts'.
      const refused = (e: Event): boolean => rt.scope?.error?.(e) === false;
      const onError = (e: Event): void => {
        if (refused(e)) return;
        if (isElement(e.target)) {
          const tag = e.target.tagName.toLowerCase();
          record(
            "resource",
            new Described("ResourceError", `${tag} failed to load: ${resourceUrl(e.target)}`),
            stamp(e),
          );
          return;
        }
        const ev = e as ErrorEvent;
        record("uncaught", ev.error ?? new Described("Error", String(ev.message ?? "")), stamp(e));
      };
      const onRejection = (e: Event): void => {
        if (refused(e)) return;
        record("unhandled_rejection", (e as PromiseRejectionEvent).reason, stamp(e));
      };
      const onCsp = (e: Event): void => {
        if (refused(e)) return;
        const v = e as SecurityPolicyViolationEvent;
        record(
          "csp",
          new Described(
            "CSPViolation",
            `${v.effectiveDirective} blocked ${blocked(String(v.blockedURI ?? ""))}`,
          ),
          stamp(e),
        );
      };
      // Errors the bootstrap buffered before RUM loaded.
      const replay = (entry: BootstrapEntry): void => {
        if (entry.kind === "error") {
          record("uncaught", entry.error ?? new Described("Error", entry.message), entry.at);
        } else if (entry.kind === "rejection") record("unhandled_rejection", entry.reason, entry.at);
        else if (entry.kind === "csp") {
          record(
            "csp",
            new Described("CSPViolation", `${entry.directive} blocked ${blocked(entry.blocked)}`),
            entry.at,
          );
        }
      };
      env.window.addEventListener("error", onError, { capture: true });
      env.window.addEventListener("unhandledrejection", onRejection);
      env.window.addEventListener("securitypolicyviolation", onCsp);

      const offBus = rt.bus.subscribe((s) => {
        if (s.type === "bootstrap") replay(s.entry);
      });
      const offNetwork = watchNetworkErrors(rt, rec);
      const offConsole =
        opts.console === true && env.console !== undefined
          ? watchConsoleErrors(
              rt,
              rec,
              env.console,
              env.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms)),
            )
          : undefined;

      return () => {
        rec.stop();
        env.window.removeEventListener("error", onError, { capture: true });
        env.window.removeEventListener("unhandledrejection", onRejection);
        env.window.removeEventListener("securitypolicyviolation", onCsp);
        offBus();
        offNetwork();
        offConsole?.();
      };
    },
  };
}

/** The errors collector: uncaught errors, unhandled rejections, resource, CSP and network failures, and optionally console.error. */
export function errors(opts: ErrorsOptions = {}): RumCollector {
  return {
    name: "errors",
    start: (rt) => errorsWith(opts, { window: globalThis, console: globalThis.console }).start(rt),
  };
}
