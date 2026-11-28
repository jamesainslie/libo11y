/**
 * A RumRuntime for collector tests, and a fake browser environment for the collectors' *With
 * seams. Tests only; never built.
 */
import type { LogAttributes } from "@libo11y/core";
import type { Context, Span, SpanContext } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { createBus } from "../bus.ts";
import type { EventBody, RumRuntime, RumSettings, RumSignal } from "../contracts/runtime.ts";
import type { SessionEvent, SessionManager, SessionState } from "../contracts/session.ts";
import type { SummaryAccumulator, SummaryCountKey } from "../contracts/summary.ts";
import type { ViewState, ViewTracker } from "../contracts/views.ts";
import { createSummaryAccumulator } from "../summary/accumulator.ts";
import { defaultViewName } from "../views/naming.ts";
import { createViewTracker } from "../views/tracker.ts";
import { type ManualTimers, manualTimers } from "./manual-timers.ts";

/** A minimal element double for the collectors, built from a spec. */
export interface ElementSpec {
  readonly tagName: string;
  readonly id?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly classes?: readonly string[];
}

export interface FakeElement {
  readonly tagName: string;
  readonly id: string;
  readonly classList: readonly string[];
  readonly parentElement: null;
  readonly isContentEditable: boolean;
  readonly ownerDocument: { getElementById(id: string): null };
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
  closest(selector: string): FakeElement | null;
}

/** Matches "tag", "[attr]" and "[attr=value]" alternatives; anything more complex never matches. */
function simpleMatch(el: ElementSpec, selector: string): boolean {
  return selector.split(",").some((raw) => {
    const part = raw.trim();
    const attr = /^\[([a-z0-9-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(part);
    if (attr !== null) {
      const v = el.attrs?.[attr[1] ?? ""];
      return v !== undefined && (attr[2] === undefined || v === attr[2]);
    }
    return /^[a-z]+$/.test(part) && el.tagName.toLowerCase() === part;
  });
}

export function fakeElement(spec: ElementSpec): FakeElement {
  const el: FakeElement = {
    tagName: spec.tagName.toUpperCase(),
    id: spec.id ?? "",
    classList: spec.classes ?? [],
    parentElement: null,
    isContentEditable: spec.attrs?.contenteditable !== undefined,
    ownerDocument: { getElementById: () => null },
    getAttribute: (n) => spec.attrs?.[n] ?? null,
    matches: (s) => simpleMatch(spec, s),
    closest: (s) => (simpleMatch(spec, s) ? el : null),
  };
  return el;
}

class FakeMutationObserver {
  static readonly instances: Set<FakeMutationObserver> = new Set();
  readonly cb: () => void;
  connected = false;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe(): void {
    this.connected = true;
    FakeMutationObserver.instances.add(this);
  }
  disconnect(): void {
    this.connected = false;
    FakeMutationObserver.instances.delete(this);
  }
  takeRecords(): [] {
    return [];
  }
}

/** The fake browser environment a fake runtime shares its clock with. */
export interface FakeEnv {
  readonly timeOrigin: number;
  readonly clock: ManualTimers;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  readonly window: EventTarget;
  readonly paint: {
    requestAnimationFrame(cb: () => void): number;
    setTimeout(cb: () => void, ms: number): unknown;
    hidden(): boolean;
  };
  hidden: boolean;
  readonly MutationObserver: new (cb: () => void) => FakeMutationObserver;
  readonly root: object;
  /** The navigation entry's loadEventEnd. Default 0, the load event has not ended. */
  loadEventEnd: number;
  navigationLoadEnd(): number;
  /** Calls cb once the load event ended: at once when loadEventEnd is set, else on fireLoad. */
  whenLoaded(cb: () => void): () => void;
  /** Ends the load event at at (default now) and runs the whenLoaded callbacks. */
  fireLoad(at?: number): void;
  readonly history: {
    location: { href: string };
    history: Pick<History, "pushState" | "replaceState">;
    addEventListener(t: "popstate", l: () => void): void;
    removeEventListener(t: "popstate", l: () => void): void;
    pop(url: string): void;
  };
  cssEscape(s: string): string;
  /** Whether a text selection is collapsed (or absent). Default true. */
  selectionCollapsed: boolean;
  /** True while a text selection is not collapsed. */
  selecting(): boolean;
  advance(ms: number): void;
  /** Runs one queued animation frame. */
  frame(): void;
  /** Runs one queued paint task. */
  task(): void;
  /** Calls every connected mutation observer. */
  mutate(): void;
  /** Observers connected now. */
  observing(): number;
  /** Dispatches a click on window whose target is an element built from spec, at timeStamp (default now). */
  click(spec: ElementSpec, timeStamp?: number): void;
  /** Dispatches a keydown of key on window whose target is an element built from spec. */
  key(key: string, spec: ElementSpec, timeStamp?: number): void;
  /** Dispatches a type event on window with the given extra properties. */
  dispatch(type: string, props: Record<string, unknown>): void;
}

function fakeEnv(clock: ManualTimers): FakeEnv {
  const loads = new Set<() => void>();
  const frames: (() => void)[] = [];
  const tasks: (() => void)[] = [];
  const target = new EventTarget();
  const win = new EventTarget();
  FakeMutationObserver.instances.clear();
  const history = {
    location: { href: "https://app.test/" },
    history: {
      pushState(_d: unknown, _u: string, url?: string | URL | null) {
        if (url != null) history.location.href = new URL(url, history.location.href).href;
      },
      replaceState(_d: unknown, _u: string, url?: string | URL | null) {
        if (url != null) history.location.href = new URL(url, history.location.href).href;
      },
    },
    addEventListener: (t: "popstate", l: () => void) => target.addEventListener(t, l),
    removeEventListener: (t: "popstate", l: () => void) => target.removeEventListener(t, l),
    pop(url: string) {
      history.location.href = url;
      target.dispatchEvent(new Event("popstate"));
    },
  };
  const dispatch = (type: string, props: Record<string, unknown>): void => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
    win.dispatchEvent(e);
  };
  const env: FakeEnv = {
    timeOrigin: 1_700_000_000_000,
    clock,
    setTimeout: (cb, ms) => clock.timers.setTimeout(cb, ms),
    clearTimeout: (h) => clock.timers.clearTimeout(h),
    window: win,
    paint: {
      requestAnimationFrame: (cb) => frames.push(cb),
      setTimeout: (cb) => tasks.push(cb),
      hidden: () => env.hidden,
    },
    hidden: false,
    MutationObserver: FakeMutationObserver,
    root: {},
    loadEventEnd: 0,
    navigationLoadEnd: () => env.loadEventEnd,
    whenLoaded(cb) {
      if (env.loadEventEnd > 0) {
        cb();
        return () => {};
      }
      loads.add(cb);
      return () => loads.delete(cb);
    },
    fireLoad(at = clock.now()) {
      env.loadEventEnd = at;
      for (const cb of [...loads]) cb();
      loads.clear();
    },
    history,
    cssEscape: (s) => s.replace(/["\\]/g, "\\$&"),
    selectionCollapsed: true,
    selecting: () => !env.selectionCollapsed,
    advance: (ms) => clock.advance(ms),
    frame: () => frames.shift()?.(),
    task: () => tasks.shift()?.(),
    mutate() {
      for (const o of [...FakeMutationObserver.instances]) if (o.connected) o.cb();
    },
    observing: () => [...FakeMutationObserver.instances].filter((o) => o.connected).length,
    click(spec, timeStamp = clock.now()) {
      dispatch("click", { target: fakeElement(spec), timeStamp });
    },
    key(key, spec, timeStamp = clock.now()) {
      dispatch("keydown", { key, target: fakeElement(spec), timeStamp, repeat: false });
    },
    dispatch,
  };
  return env;
}

export interface FakeRuntime extends RumRuntime {
  readonly counts: SummaryCountKey[];
  /** The n of each count, in step with counts. */
  readonly countValues: number[];
  readonly retained: string[];
  readonly signals: RumSignal[];
  readonly events: { name: string; attrs: LogAttributes; ctx?: Context; body?: EventBody }[];
  readonly crumbs: string[];
  readonly summaries: Record<string, string | number>[];
  readonly exporter: InMemorySpanExporter;
  readonly provider: TracerProvider;
  /** The views of a realViews runtime, with begin and the test hooks of the real tracker. */
  readonly views: ViewTracker;
  readonly gate: RumRuntime["gate"] & { open: boolean };
  t: number;
  /** Runs the hide hooks, as the first of visibilitychange and pagehide does. */
  hide(): void;
  /** Replaces the current session with one of this ID, as a revoke and grant would. */
  setSession(id: string): void;
  fakeEnv(): FakeEnv;
  flushSpans(): Promise<void>;
}

const FIXED_VIEW: ViewState = { id: "v0", name: "/", kind: "initial", startTime: 0, sessionId: "s1" };

export function fakeRuntime(opts: { readonly realViews?: boolean } = {}): FakeRuntime {
  const clock = manualTimers();
  const env = fakeEnv(clock);
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const bus = createBus();
  const signals: RumSignal[] = [];
  bus.subscribe((s) => signals.push(s));
  const counts: SummaryCountKey[] = [];
  const countValues: number[] = [];
  const retained: string[] = [];
  const summaries: Record<string, string | number>[] = [];
  const events: FakeRuntime["events"] = [];
  const crumbs: string[] = [];
  let active: Span | undefined;
  const hideHooks = new Set<() => void>();
  let kept = false;
  let sessionState: SessionState = { id: "s1", startedAt: 0, lastActivityAt: 0, sampled: false };
  const sessionListeners = new Set<(e: SessionEvent) => void>();
  const session: SessionManager = {
    start: async () => {},
    current: () => sessionState,
    touch: () => {},
    kept: () => kept,
    retain(reason) {
      retained.push(reason);
      if (kept) return false;
      kept = true;
      return true;
    },
    decide: () => (kept ? "send" : "buffer"),
    clear: () => {},
    subscribe(l) {
      sessionListeners.add(l);
      return () => sessionListeners.delete(l);
    },
    close: () => {},
  };
  const inner = createSummaryAccumulator({
    platform: "web",
    emit: (a) => summaries.push(a),
    now: () => clock.now(),
    visible: () => true,
  });
  const summary: SummaryAccumulator = {
    ...inner,
    count(key, n) {
      counts.push(key);
      countValues.push(n ?? 1);
      inner.count(key, n);
    },
  };
  let appLoad: SpanContext | undefined;
  const views: ViewTracker =
    opts.realViews === true
      ? createViewTracker({
          session,
          summary,
          viewName: defaultViewName,
          location: () => env.history.location.href,
          now: () => clock.now(),
          prerendered: () => false,
        })
      : {
          current: () => FIXED_VIEW,
          loadView: () => FIXED_VIEW,
          start: () => FIXED_VIEW,
          rename: () => {},
          rendered: () => {},
          appLoadStarted: (c) => {
            appLoad = c;
          },
          appLoad: () => appLoad,
          attachSpan: () => {},
          begin: () => {},
          end: () => {},
          subscribe: () => () => {},
        };
  const gate = {
    open: true,
    recording: () => gate.open,
    subscribe: () => () => {},
    onRevoke: () => () => {},
  };
  const settings: RumSettings = {
    sessionSampleRate: 1,
    sessionIdleMillis: 900_000,
    sessionMaxMillis: 14_400_000,
    queryAllowList: new Set(),
    enabled: new Set(),
    viewName: defaultViewName,
  };
  const rt: FakeRuntime = {
    platform: "web",
    telemetry: {} as RumRuntime["telemetry"],
    tracer: provider.getTracer("@libo11y/rum"),
    gate: gate as FakeRuntime["gate"],
    session,
    views,
    summary,
    bus,
    settings: () => settings,
    now: () => clock.now(),
    emit(name, attrs = {}, ctx, body) {
      if (!gate.open) return;
      events.push({
        name,
        attrs,
        ...(ctx === undefined ? {} : { ctx }),
        ...(body === undefined ? {} : { body }),
      });
    },
    onRequestStart: () => () => {},
    activeAction: () => active,
    setActiveAction(s) {
      active = s;
    },
    breadcrumbs: () => crumbs,
    ignored: () => false,
    onHide(hook) {
      hideHooks.add(hook);
      return () => hideHooks.delete(hook);
    },
    hide() {
      for (const h of [...hideHooks]) h();
    },
    counts,
    countValues,
    retained,
    signals,
    events,
    crumbs,
    summaries,
    exporter,
    provider,
    get t() {
      return clock.now();
    },
    set t(v: number) {
      clock.advance(v - clock.now());
    },
    setSession(id) {
      sessionState = { ...sessionState, id };
    },
    fakeEnv: () => env,
    flushSpans: () => provider.forceFlush(),
  };
  return rt;
}
