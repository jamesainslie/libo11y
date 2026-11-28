import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import type { VitalMetric } from "./attribution.ts";
import { trustedTargets, vitalsWith } from "./collector.ts";

const metric = (
  name: VitalMetric["name"],
  value: number,
  navigationType = "navigate",
  attribution: Record<string, unknown> = {},
  id = `${name}-1`,
): VitalMetric => ({ name, value, delta: value, id, navigationType, attribution });

function capture(): { register: (r: (m: VitalMetric) => void) => void; report: (m: VitalMetric) => void } {
  let target: (m: VitalMetric) => void = () => {};
  return {
    register: (r) => {
      target = r;
    },
    report: (m) => target(m),
  };
}

const webVitals = (rt: ReturnType<typeof fakeRuntime>) =>
  rt.events.filter((e) => e.name === "browser.web_vital");

test("FCP and TTFB are final when reported and go to the load view at once", () => {
  const rt = fakeRuntime({ realViews: true });
  const c = capture();
  rt.views.begin();
  const first = rt.views.current();
  vitalsWith(c.register).start(rt);
  c.report(metric("TTFB", 300));
  c.report(metric("FCP", 900));
  assert.deepEqual(
    webVitals(rt).map((e) => e.body),
    [
      { name: "ttfb", value: 0.3, delta: 0.3, id: "TTFB-1" },
      { name: "fcp", value: 0.9, delta: 0.9, id: "FCP-1" },
    ],
  );
  rt.summary.flush();
  const s = rt.summaries.find((x) => x["o11y.rum.view.id"] === first?.id);
  assert.equal(s?.["o11y.rum.summary.ttfb.value"], 0.3);
  assert.equal(s?.["o11y.rum.summary.fcp.value"], 0.9);
});

test("LCP, CLS and INP keep their latest value until the page is hidden, then go to the load view once", () => {
  const rt = fakeRuntime({ realViews: true });
  const c = capture();
  rt.views.begin();
  const first = rt.views.current();
  vitalsWith(c.register).start(rt);
  rt.views.start({ kind: "soft", name: "/next" });
  c.report(metric("LCP", 1200));
  c.report(metric("LCP", 1500));
  c.report(metric("CLS", 0.02));
  c.report(metric("CLS", 0.05));
  c.report(metric("INP", 240, "navigate", { interactionTarget: "#save", inputDelay: 12 }));
  assert.equal(webVitals(rt).length, 0, "nothing is final before the page is hidden");
  rt.hide();
  rt.summary.flush();
  const late = rt.summaries.find(
    (s) => s["o11y.rum.view.id"] === first?.id && s["o11y.rum.summary.seq"] === 1,
  );
  assert.equal(late?.["o11y.rum.summary.lcp.value"], 1.5);
  assert.equal(late?.["o11y.rum.summary.cls.value"], 0.05);
  assert.equal(late?.["o11y.rum.summary.inp.value"], 0.24);
  const soft = rt.summaries.filter((s) => s["o11y.rum.view.name"] === "/next");
  assert.equal(
    soft.some((s) => Object.keys(s).some((k) => k.endsWith(".value"))),
    false,
  );
  const events = webVitals(rt);
  assert.deepEqual(
    events.map((e) => e.body),
    [
      { name: "lcp", value: 1.5, delta: 1.5, id: "LCP-1" },
      { name: "cls", value: 0.05, delta: 0.05, id: "CLS-1" },
      { name: "inp", value: 0.24, delta: 0.24, id: "INP-1" },
    ],
  );
  const inp = events[2];
  assert.equal(inp?.attrs["o11y.rum.view.id"], first?.id);
  assert.equal(inp?.attrs["session.id"], first?.sessionId);
  assert.equal(inp?.attrs["o11y.rum.element.selector"], "#save");
  assert.equal(inp?.attrs["o11y.rum.vital.attribution.input_delay"], 0.012);
  for (const e of events) {
    assert.equal(
      Object.keys(e.attrs).some((k) => k.includes("rating")),
      false,
    );
  }
});

test("a CLS change after the page returns from hidden stays out of the summary but is still recorded as detail", () => {
  const rt = fakeRuntime({ realViews: true });
  const c = capture();
  rt.views.begin();
  const first = rt.views.current();
  vitalsWith(c.register).start(rt);
  c.report(metric("CLS", 0.05));
  rt.hide();
  rt.summary.flush();
  rt.t += 1000; // visible again
  c.report(metric("CLS", 0.09));
  rt.hide();
  rt.summary.flush();
  rt.hide(); // nothing changed since
  const ofView = rt.summaries.filter((s) => s["o11y.rum.view.id"] === first?.id);
  assert.deepEqual(
    ofView.map((s) => s["o11y.rum.summary.cls.value"]),
    [0.05, undefined],
  );
  const cls = webVitals(rt).map((e) => e.body);
  assert.equal(cls.length, 2);
  assert.equal(cls[1]?.value, 0.09);
  assert.ok(Math.abs(Number(cls[1]?.delta) - 0.04) < 1e-9);
});

test("a bfcache-restore report goes to the restored view", async () => {
  const rt = fakeRuntime({ realViews: true });
  const c = capture();
  rt.views.begin();
  const stop = vitalsWith(c.register).start(rt);
  const restored = rt.views.start({ kind: "bfcache_restore", name: "/" });
  c.report(metric("INP", 300, "back-forward-cache", {}, "INP-2"));
  c.report(metric("CLS", 0.02));
  await new Promise((r) => setTimeout(r, 0));
  rt.hide();
  rt.summary.flush();
  stop();
  const ofRestored = rt.summaries.find((s) => s["o11y.rum.view.id"] === restored.id);
  assert.equal(ofRestored?.["o11y.rum.summary.inp.value"], 0.3);
  assert.equal(
    ofRestored?.["o11y.rum.summary.cls.value"],
    undefined,
    "a navigate report stays on the first load",
  );
});

test("a bfcache-restore report with no restored view is dropped", async () => {
  const rt = fakeRuntime({ realViews: true });
  const c = capture();
  rt.views.begin();
  vitalsWith(c.register).start(rt);
  c.report(metric("TTFB", 20, "back-forward-cache"));
  await new Promise((r) => setTimeout(r, 0));
  rt.summary.flush();
  assert.equal(rt.events.length, 0);
  assert.equal(rt.summaries[0]?.["o11y.rum.summary.ttfb.value"], undefined);
});

test("reports while stopped are dropped, held values are forgotten, and a restart does not register twice", () => {
  const rt = fakeRuntime({ realViews: true });
  let registrations = 0;
  let report: (m: VitalMetric) => void = () => {};
  const c = vitalsWith((r) => {
    registrations++;
    report = r;
  });
  rt.views.begin();
  const stop = c.start(rt);
  report(metric("CLS", 0.1));
  stop();
  report(metric("FCP", 900));
  rt.hide();
  c.start(rt);
  rt.hide();
  assert.equal(registrations, 1);
  assert.equal(rt.events.length, 0);
});

test("after consent is granted again, the old page load's vitals are not reported", () => {
  const rt = fakeRuntime({ realViews: true });
  const c = capture();
  const collector = vitalsWith(c.register);
  rt.views.begin();
  collector.start(rt)();
  // Revoked and granted again: a new session whose first view is soft.
  rt.views.end();
  rt.summary.reset();
  rt.setSession("s2");
  rt.views.begin();
  collector.start(rt);
  c.report(metric("LCP", 1200));
  rt.hide();
  rt.summary.flush();
  assert.equal(rt.events.length, 0);
  assert.equal(
    rt.summaries.some((s) => s["o11y.rum.summary.lcp.value"] !== undefined),
    false,
  );
});

test("held vitals reach the load view's summary even after many soft views", () => {
  const rt = fakeRuntime({ realViews: true });
  const c = capture();
  rt.views.begin();
  const first = rt.views.current();
  vitalsWith(c.register).start(rt);
  c.report(metric("LCP", 1500));
  c.report(metric("CLS", 0.05));
  for (let i = 0; i < 12; i++) rt.views.start({ kind: "soft", name: `/p${i}` });
  rt.hide();
  rt.summary.flush();
  const s = rt.summaries.find(
    (x) => x["o11y.rum.view.id"] === first?.id && x["o11y.rum.summary.lcp.value"] !== undefined,
  );
  assert.equal(s?.["o11y.rum.summary.lcp.value"], 1.5);
  assert.equal(s?.["o11y.rum.summary.cls.value"], 0.05);
});

test("an INP first measured after the page returns from hidden is detail only", () => {
  const rt = fakeRuntime({ realViews: true });
  const c = capture();
  rt.views.begin();
  vitalsWith(c.register).start(rt);
  rt.hide();
  rt.summary.flush();
  rt.t += 1000;
  c.report(metric("INP", 400));
  rt.hide();
  rt.summary.flush();
  assert.equal(
    rt.summaries.some((s) => s["o11y.rum.summary.inp.value"] !== undefined),
    false,
  );
  assert.deepEqual(
    webVitals(rt).map((e) => e.body?.name),
    ["inp"],
  );
});

test("a bfcache-restore report that arrives before the restored view starts still goes to it", async () => {
  const rt = fakeRuntime({ realViews: true });
  const c = capture();
  rt.views.begin();
  const stop = vitalsWith(c.register).start(rt);
  // web-vitals reports TTFB from its own pageshow listener, which can run before the tracker's.
  c.report(metric("TTFB", 20, "back-forward-cache", {}, "TTFB-2"));
  const restored = rt.views.start({ kind: "bfcache_restore", name: "/" });
  await new Promise((r) => setTimeout(r, 0));
  rt.summary.flush();
  stop();
  assert.equal(
    rt.summaries.find((s) => s["o11y.rum.view.id"] === restored.id)?.["o11y.rum.summary.ttfb.value"],
    0.02,
  );
});

test("a bfcache-restore report deferred past a revoke is dropped", async () => {
  const rt = fakeRuntime({ realViews: true });
  const c = capture();
  rt.views.begin();
  const stop = vitalsWith(c.register).start(rt);
  rt.views.start({ kind: "bfcache_restore", name: "/" });
  c.report(metric("TTFB", 20, "back-forward-cache", {}, "TTFB-2"));
  stop();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rt.events.length, 0);
});

test("only selectors RUM built are kept; web-vitals' own fallbacks are dropped", () => {
  const targets = trustedTargets(
    (node) => (node === null ? undefined : `#${String((node as unknown as { id: string }).id)}`),
    2,
  );
  const made = targets.generateTarget({ id: "save" } as unknown as Node);
  assert.equal(made, "#save");
  assert.deepEqual(targets.clean({ interactionTarget: "#save", inputDelay: 3 }), {
    interactionTarget: "#save",
    inputDelay: 3,
  });
  // An LCP element removed from the DOM: web-vitals falls back to "#" + its raw ID.
  assert.deepEqual(targets.clean({ target: "#avatar-user-482913", timeToFirstByte: 1 }), {
    timeToFirstByte: 1,
  });
  // A detached INP target: the browser's own targetSelector.
  assert.deepEqual(targets.clean({ largestShiftTarget: "div#order-12345" }), {});
  targets.generateTarget({ id: "a" } as unknown as Node);
  targets.generateTarget({ id: "b" } as unknown as Node);
  assert.deepEqual(targets.clean({ target: "#save" }), {}, "only the most recent selectors are remembered");
});
