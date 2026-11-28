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
 * one is being recorded is not recorded again. Stop removes the listeners and restores
 * console.error when it is still RUM's wrapper.
 */
import type { RUMErrorSource } from "@libo11y/spec";
import type { BootstrapEntry } from "../bootstrap/buffer.ts";
import type { RumCollector, RumRuntime } from "../contracts/runtime.ts";
import { normalizeError } from "./normalize.ts";
import { recordError, wasRecorded } from "./record.ts";

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

/** The error.type values of a request the app aborted, which is not a failure. */
const ABORTED: ReadonlySet<string> = new Set(["AbortError", "abort"]);

/** An Error-like value recordError reads as is, so the type and message are exactly these. */
class Described extends Error {
  constructor(name: string, message: string, stack?: string) {
    super(message);
    this.name = name;
    this.stack = stack ?? "";
  }
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

function host(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return "";
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

function consoleError(args: readonly unknown[]): Described {
  let first: ReturnType<typeof normalizeError> | undefined;
  const parts = args.map((a) => {
    if (a instanceof Error) {
      const n = normalizeError(a);
      first ??= n;
      return n.message;
    }
    try {
      return String(a);
    } catch {
      return "[object]";
    }
  });
  return new Described(first?.type ?? "ConsoleError", parts.join(" "), first?.stack);
}

export function errorsWith(opts: ErrorsOptions, env: ErrorsEnv): RumCollector {
  return {
    name: "errors",
    start(rt: RumRuntime) {
      let stopped = false;
      let recording = false;
      const record = (source: RUMErrorSource, error: unknown, at?: number): void => {
        if (stopped || recording) return;
        recording = true;
        try {
          recordError(rt, source, error, at === undefined ? {} : { at });
        } finally {
          recording = false;
        }
      };
      const stamp = (e: Event): number | undefined =>
        Number.isFinite(e.timeStamp) && e.timeStamp > 0 && e.timeStamp <= rt.now() ? e.timeStamp : undefined;

      const onError = (e: Event): void => {
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
        record("unhandled_rejection", (e as PromiseRejectionEvent).reason, stamp(e));
      };
      const onCsp = (e: Event): void => {
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

      // Requests in flight, so a failed one can be described by its method and host.
      const requests = new Map<string, { method: string; url: string }>();
      const offBus = rt.bus.subscribe((s) => {
        if (s.type === "bootstrap") replay(s.entry);
        else if (s.type === "request-start") requests.set(s.spanId, { method: s.method, url: s.url });
        else if (s.type === "request-end") {
          const r = requests.get(s.spanId);
          requests.delete(s.spanId);
          if (r !== undefined && s.status === undefined && !ABORTED.has(s.errorType ?? "")) {
            record("network", new Described("NetworkError", `${r.method} ${host(r.url)} failed`), s.at);
          }
        }
      });

      const con = opts.console === true ? env.console : undefined;
      const original = con?.error;
      const wrapper =
        con === undefined || original === undefined
          ? undefined
          : (...args: unknown[]): void => {
              try {
                const logged = args.filter((a): a is object => typeof a === "object" && a !== null);
                if (logged.length === 0) record("console", consoleError(args));
                else if (!logged.some((a) => wasRecorded(rt, a))) {
                  // React 19 logs an error a boundary caught before componentDidCatch records it with
                  // its component stack, so the console record waits a task and yields to that one.
                  const at = rt.now();
                  const later = env.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
                  later(() => {
                    if (!logged.some((a) => wasRecorded(rt, a))) record("console", consoleError(args), at);
                  }, 0);
                }
              } finally {
                original.apply(con, args);
              }
            };
      if (con !== undefined && wrapper !== undefined) con.error = wrapper;

      return () => {
        stopped = true;
        env.window.removeEventListener("error", onError, { capture: true });
        env.window.removeEventListener("unhandledrejection", onRejection);
        env.window.removeEventListener("securitypolicyviolation", onCsp);
        offBus();
        requests.clear();
        if (con !== undefined && original !== undefined && con.error === wrapper) con.error = original;
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
