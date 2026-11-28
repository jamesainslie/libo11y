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

/** For tests: the vitals collector over an injected registration function. */
export function vitalsWith(register: VitalRegistrar): RumCollector {
  let registered = false;
  let running: RumRuntime | undefined;
  let load: ViewState | undefined;
  /** The latest uncommitted report of each metric instance, by web-vitals id. */
  const held = new Map<string, Held>();
  /** The value last committed for each metric instance, in web-vitals units. */
  const committed = new Map<string, number>();

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
    rt.summary.vital(view.id, name, value);
    rt.emit(
      EVENT_BROWSER_WEB_VITAL,
      { ...attributionAttributes(m), [ATTR_SESSION_ID]: view.sessionId, [ATTR_RUM_VIEW_ID]: view.id },
      undefined,
      { name, value, delta: vitalValue(name, m.value - (previous ?? 0)), id: m.id },
    );
  };
  const report = (m: VitalMetric): void => {
    const rt = running;
    if (rt === undefined || !rt.gate.recording()) return;
    const view = target(rt, m);
    if (view === undefined) return;
    if (FINAL_AT_REPORT.has(m.name)) commit(rt, { metric: m, view });
    else held.set(m.id, { metric: m, view });
  };

  return {
    name: "vitals",
    start(rt) {
      const v = rt.views.loadView();
      load = v !== undefined && v.sessionId === rt.session.current()?.id ? v : undefined;
      running = rt;
      const offHide = rt.onHide(() => {
        if (running !== rt || !rt.gate.recording()) return;
        const due = [...held.values()];
        held.clear();
        for (const h of due) commit(rt, h);
      });
      if (!registered) {
        registered = true;
        register(report);
      }
      return () => {
        offHide();
        if (running === rt) running = undefined;
        load = undefined;
        held.clear();
      };
    },
  };
}

function generateTarget(node: Node | null): string | undefined {
  return typeof Element !== "undefined" && node instanceof Element ? elementSelector(node) : undefined;
}

const registerWebVitals: VitalRegistrar = (report) => {
  const opts = { reportAllChanges: true, generateTarget };
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
      attribution: m.attribution as Readonly<Record<string, unknown>>,
    });
  onLCP(forward, opts);
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
