/**
 * The bootstrap buffer, shared by the tiny `@libo11y/rum/bootstrap` entry and the
 * collectors through a global registered symbol, so the two meet even when bundled apart. It has no
 * imports.
 *
 * Only consent already "granted" buffers anything. Then the buffer holds, in memory and never in
 * storage, up to maxEntries early errors (ErrorEvents whose target is not an element: an element's
 * error is a resource error, the errors collector's job), unhandled rejections, CSP violations and
 * clicks, for at most BOOTSTRAP_MAX_MILLIS, after which its listeners are removed. setupRum takes
 * the buffer just before its collectors start, and replays it once they started, only when it
 * starts with consent granted.
 */

export const BOOTSTRAP_KEY: unique symbol = Symbol.for("libo11y.rum.bootstrap") as never;
/** The bootstrap stops buffering this long after it was installed. */
export const BOOTSTRAP_MAX_MILLIS = 30_000;
const DEFAULT_MAX_ENTRIES = 100;

/** One early event. at is performance.now() when it happened. */
export type BootstrapEntry =
  | { readonly kind: "error"; readonly at: number; readonly error: unknown; readonly message: string }
  | { readonly kind: "rejection"; readonly at: number; readonly reason: unknown }
  | { readonly kind: "csp"; readonly at: number; readonly directive: string; readonly blocked: string }
  | { readonly kind: "click"; readonly at: number; readonly target: Element };

export interface BootstrapBuffer {
  readonly entries: BootstrapEntry[];
  /** performance.now() when the bootstrap was installed. */
  readonly startedAt: number;
  /** Removes the listeners. Idempotent. */
  stop(): void;
}

/** Options for installRumBootstrap. */
export interface RumBootstrapOptions {
  /** The consent state setupRum will start with. Only "granted" buffers anything. Default "pending". */
  readonly consent?: "pending" | "granted";
  /** The most entries held. Default 100. */
  readonly maxEntries?: number;
}

/** The clock the bootstrap runs on. */
export interface BootstrapClock {
  /** performance.now(). */
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
}

type Holder = { [BOOTSTRAP_KEY]?: BootstrapBuffer | undefined };
const holder = globalThis as Holder;

/** The page's bootstrap buffer, if a bootstrap installed one and nothing took it yet. */
export function bootstrapBuffer(): BootstrapBuffer | undefined {
  return holder[BOOTSTRAP_KEY];
}

/** Takes the buffer out of the page, its listeners removed: later calls return undefined. */
export function takeBootstrap(): BootstrapBuffer | undefined {
  const b = holder[BOOTSTRAP_KEY];
  holder[BOOTSTRAP_KEY] = undefined;
  b?.stop();
  return b;
}

const isElement = (v: unknown): boolean =>
  typeof v === "object" && v !== null && typeof (v as { tagName?: unknown }).tagName === "string";

/** installRumBootstrap with the event target and clock given. Internal: tests inject both. */
export function installRumBootstrapOn(
  target: EventTarget,
  opts: RumBootstrapOptions,
  clock: BootstrapClock,
): void {
  if (opts.consent !== "granted" || holder[BOOTSTRAP_KEY] !== undefined) return;
  const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const startedAt = clock.now();
  const entries: BootstrapEntry[] = [];
  const at = (e: Event): number => {
    const now = clock.now();
    return Number.isFinite(e.timeStamp) && e.timeStamp > 0 && e.timeStamp <= now ? e.timeStamp : now;
  };
  let stopped = false;
  const push = (entry: BootstrapEntry): void => {
    if (clock.now() - startedAt >= BOOTSTRAP_MAX_MILLIS) stop();
    else if (entries.length < max) entries.push(entry);
  };
  const onError = (e: Event): void => {
    const ev = e as ErrorEvent;
    if (isElement(ev.target)) return;
    push({ kind: "error", at: at(e), error: ev.error, message: String(ev.message ?? "") });
  };
  const onRejection = (e: Event): void => {
    push({ kind: "rejection", at: at(e), reason: (e as PromiseRejectionEvent).reason });
  };
  const onCsp = (e: Event): void => {
    const v = e as SecurityPolicyViolationEvent;
    push({
      kind: "csp",
      at: at(e),
      directive: String(v.effectiveDirective ?? ""),
      blocked: String(v.blockedURI ?? ""),
    });
  };
  const onClick = (e: Event): void => {
    if (isElement(e.target)) push({ kind: "click", at: at(e), target: e.target as Element });
  };
  const listeners: [string, (e: Event) => void, boolean][] = [
    ["error", onError, true],
    ["unhandledrejection", onRejection, false],
    ["securitypolicyviolation", onCsp, false],
    ["click", onClick, true],
  ];
  function stop(): void {
    if (stopped) return;
    stopped = true;
    for (const [type, l, capture] of listeners) target.removeEventListener(type, l, { capture });
  }
  for (const [type, l, capture] of listeners) target.addEventListener(type, l, { capture });
  clock.setTimeout(stop, BOOTSTRAP_MAX_MILLIS);
  holder[BOOTSTRAP_KEY] = { entries, startedAt, stop };
}

/** What afterLoad needs from the page. */
export interface LoadHost {
  readonly document?: { readonly readyState?: string };
  readonly window?: EventTarget;
  /** requestIdleCallback where there is one, else a zero timeout. */
  idle(cb: () => void): void;
}

/** afterLoad with the page given. Internal: tests inject it. */
export function afterLoadOn(host: LoadHost, load: () => void): void {
  if (host.document?.readyState === "complete" || host.window === undefined) {
    host.idle(load);
    return;
  }
  host.window.addEventListener("load", () => host.idle(load), { once: true });
}
