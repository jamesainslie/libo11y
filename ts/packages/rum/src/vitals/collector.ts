/**
 * The vitals() collector: LCP, INP, CLS, FCP and TTFB from the web-vitals attribution build
 * (decision P6), attributed to the view that loaded the page (decision P7, orchestrator Q5).
 *
 * Rules. The web-vitals callbacks are registered once per page, on the first start, with
 * reportAllChanges true, and forward to the running collector: a revoked and granted page does not
 * register twice, and reports while stopped are dropped. A report with navigationType
 * back-forward-cache targets the current bfcache_restore view; any other report targets the load
 * view current when the collector started, provided it belongs to the session of that start (after
 * a revoke and grant, the old page load's vitals are not reported).
 *
 * FCP and TTFB are final when reported and are committed at once. LCP, CLS and INP change while the
 * page is visible: the collector keeps the latest report of each and commits it when the page is
 * hidden (runtime.onHide), which runs before the summaries are emitted and exported. web-vitals
 * reports its own hide values from a capture listener on window, which runs before RUM's, and on a
 * navigation RUM's hide runs at pagehide, before web-vitals sees visibilitychange, so the values
 * committed are the latest ones known then. Committing calls summary.vital, which keeps the first
 * value per view and vital, so a CLS or INP change after the page returns from hidden stays out of
 * the summary (spec 1.3.0, once per view). Every commit of a changed value also goes out as the
 * semconv browser.web_vital event, detail that only kept sessions send: its body carries name
 * (lowercase), value, delta since the previous commit, and id, in the spec's units; its attributes
 * the target view, its session and the attribution. No rating is ever sent. Stop forgets the
 * values not yet committed.
 */
import { ATTR_RUM_VIEW_ID } from "@libo11y/spec";
import { onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals/attribution";
import { elementSelector } from "../actions/naming.ts";
import { ATTR_SESSION_ID } from "../attrs.ts";
import type { RumCollector, RumRuntime } from "../contracts/runtime.ts";
import type { VitalName } from "../contracts/summary.ts";
import type { ViewState } from "../contracts/views.ts";
import { attributionAttributes, type VitalMetric, vitalValue } from "./attribution.ts";
import { type LcpMetric, staleLcpAttribution } from "./lcp.ts";

export type { VitalMetric } from "./attribution.ts";

/** semconv's event for one web vital report. */
export const EVENT_BROWSER_WEB_VITAL = "browser.web_vital";

/** Registers report with the vitals source, once. */
export type VitalRegistrar = (report: (metric: VitalMetric) => void) => void;

/** Vitals that are final when first reported. */
const FINAL_AT_REPORT: ReadonlySet<VitalMetric["name"]> = new Set(["FCP", "TTFB"]);

interface Held {
  readonly metric: VitalMetric;
  readonly view: ViewState;
}

/** How long the views a page loaded are remembered as already hidden once. */
const MAX_HIDDEN_VIEWS = 16;
const CHANGE_AFTER_HIDE: ReadonlySet<VitalName> = new Set(["inp", "cls"]);

/** For tests: the vitals collector over an injected registration function and task scheduler. */
export function vitalsWith(
  register: VitalRegistrar,
  defer: (cb: () => void) => void = (cb) => setTimeout(cb, 0),
): RumCollector {
  let registered = false;
  let running: RumRuntime | undefined;
  let load: ViewState | undefined;
  /** Bumped by every start and stop, so a deferred report of an earlier run is dropped. */
  let generation = 0;
  /** The latest uncommitted report of each metric instance, by web-vitals id. */
  const held = new Map<string, Held>();
  /** The value last committed for each metric instance, in web-vitals units. */
  const committed = new Map<string, number>();
  /** Load views the page has been hidden on at least once: later INP and CLS values are detail only. */
  const hiddenOnce = new Set<string>();

  const target = (rt: RumRuntime, m: VitalMetric): ViewState | undefined => {
    if (m.navigationType !== "back-forward-cache") return load;
    const v = rt.views.loadView();
    return v?.kind === "bfcache_restore" ? v : undefined;
  };
  const commit = (rt: RumRuntime, { metric: m, view }: Held): void => {
    const previous = committed.get(m.id);
    if (previous === m.value) return;
    committed.set(m.id, m.value);
    const name = m.name.toLowerCase() as VitalName;
    const value = vitalValue(name, m.value);
    if (!(CHANGE_AFTER_HIDE.has(name) && hiddenOnce.has(view.id))) rt.summary.vital(view.id, name, value);
    rt.emit(
      EVENT_BROWSER_WEB_VITAL,
      { ...attributionAttributes(m), [ATTR_SESSION_ID]: view.sessionId, [ATTR_RUM_VIEW_ID]: view.id },
      undefined,
      { name, value, delta: vitalValue(name, m.value - (previous ?? 0)), id: m.id },
    );
  };
  const accept = (rt: RumRuntime, m: VitalMetric): void => {
    const view = target(rt, m);
    if (view === undefined) return;
    if (FINAL_AT_REPORT.has(m.name)) {
      commit(rt, { metric: m, view });
      return;
    }
    held.set(m.id, { metric: m, view });
    // Pinned until committed, so the load view is not forgotten after many soft views.
    rt.summary.pin(view.id, true);
  };
  const report = (m: VitalMetric): void => {
    const rt = running;
    if (rt === undefined || !rt.gate.recording()) return;
    if (m.navigationType !== "back-forward-cache") {
      accept(rt, m);
      return;
    }
    // web-vitals reports a restore from its own pageshow listener, which may run before the view
    // tracker's has started the bfcache_restore view, so a restore's report waits a task.
    const gen = generation;
    defer(() => {
      if (gen === generation && running === rt && rt.gate.recording()) accept(rt, m);
    });
  };
  const unpinHeld = (rt: RumRuntime): void => {
    for (const h of held.values()) rt.summary.pin(h.view.id, false);
    held.clear();
  };

  return {
    name: "vitals",
    start(rt) {
      generation++;
      const v = rt.views.loadView();
      load = v !== undefined && v.sessionId === rt.session.current()?.id ? v : undefined;
      running = rt;
      const offHide = rt.onHide(() => {
        if (running !== rt || !rt.gate.recording()) return;
        const due = [...held.values()];
        unpinHeld(rt);
        for (const h of due) commit(rt, h);
        for (const view of [load, rt.views.loadView()]) {
          if (view === undefined) continue;
          hiddenOnce.delete(view.id);
          hiddenOnce.add(view.id);
        }
        while (hiddenOnce.size > MAX_HIDDEN_VIEWS)
          hiddenOnce.delete(hiddenOnce.values().next().value as string);
      });
      if (!registered) {
        registered = true;
        register(report);
      }
      return () => {
        generation++;
        offHide();
        unpinHeld(rt);
        if (running === rt) running = undefined;
        load = undefined;
      };
    },
  };
}

/** The attribution fields that hold an element selector. */
const TARGET_FIELDS = ["target", "interactionTarget", "largestShiftTarget"] as const;
const MAX_TRUSTED_TARGETS = 64;

/**
 * Element selectors RUM built. web-vitals calls generateTarget only for an element still in the
 * page; otherwise it falls back to "#" plus the element's raw ID (LCP) or the browser's own
 * targetSelector (INP), which skip RUM's rules for generated IDs. clean keeps a selector field only
 * when generateTarget returned that selector recently, and drops it otherwise.
 */
export function trustedTargets(
  select: (node: Node | null) => string | undefined,
  max: number = MAX_TRUSTED_TARGETS,
): {
  generateTarget(node: Node | null): string | undefined;
  clean(attribution: Readonly<Record<string, unknown>>): Record<string, unknown>;
} {
  const made = new Set<string>();
  return {
    generateTarget(node) {
      const selector = select(node);
      if (selector === undefined) return undefined;
      made.delete(selector);
      made.add(selector);
      while (made.size > max) made.delete(made.values().next().value as string);
      return selector;
    },
    clean(attribution) {
      const out: Record<string, unknown> = { ...attribution };
      for (const field of TARGET_FIELDS) {
        const v = out[field];
        if (v !== undefined && !(typeof v === "string" && made.has(v))) delete out[field];
      }
      return out;
    },
  };
}

const registerWebVitals: VitalRegistrar = (report) => {
  const targets = trustedTargets((node) =>
    typeof Element !== "undefined" && node instanceof Element ? elementSelector(node) : undefined,
  );
  const opts = { reportAllChanges: true, generateTarget: targets.generateTarget };
  const forward = (m: {
    name: VitalMetric["name"];
    value: number;
    delta: number;
    id: string;
    navigationType: string;
    attribution: object;
  }): void =>
    report({
      name: m.name,
      value: m.value,
      delta: m.delta,
      id: m.id,
      navigationType: m.navigationType,
      attribution: targets.clean(m.attribution as Readonly<Record<string, unknown>>),
    });
  // A later LCP candidate of the same paint (Firefox) updates the metric's entries without a
  // report (see lcp.ts). web-vitals names each candidate's element before it processes the entry,
  // so once a batch of entries is processed, a metric whose latest entry is not the one attributed
  // is attributed again and reported again with the same value.
  const lcpTargets = new WeakMap<Node, string>();
  let lastLcp: Parameters<Parameters<typeof onLCP>[0]>[0] | undefined;
  let catchUpQueued = false;
  const catchUp = (): void => {
    catchUpQueued = false;
    const m = lastLcp;
    if (m === undefined) return;
    const attribution = staleLcpAttribution(
      m as unknown as LcpMetric,
      (e) => (e.element ? lcpTargets.get(e.element) : undefined),
      (url) =>
        performance.getEntriesByType("resource").find((r) => r.name === url) as
          | PerformanceResourceTiming
          | undefined,
    );
    if (attribution === undefined) return;
    // As web-vitals does on each report, so the next batch compares against this entry.
    Object.assign(m, { attribution });
    forward(m);
  };
  const lcpOpts = {
    reportAllChanges: true,
    generateTarget: (node: Node | null): string | undefined => {
      const selector = targets.generateTarget(node);
      if (node !== null && selector !== undefined) lcpTargets.set(node, selector);
      if (!catchUpQueued) {
        catchUpQueued = true;
        queueMicrotask(catchUp);
      }
      return selector;
    },
  };
  onLCP((m) => {
    lastLcp = m;
    forward(m);
  }, lcpOpts);
  onINP(forward, opts);
  onCLS(forward, opts);
  onFCP(forward, opts);
  onTTFB(forward, opts);
};

let shared: RumCollector | undefined;

/**
 * Records LCP, INP, CLS, FCP and TTFB with attribution on the view that loaded the page. Every
 * call returns the same collector, because web-vitals observes a page once.
 */
export function vitals(): RumCollector {
  shared ??= vitalsWith(registerWebVitals);
  return shared;
}
