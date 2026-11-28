import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { RENDER_IDLE_MILLIS, VIEW_SPAN_CAP_MILLIS, viewsWith } from "./collector.ts";

function setup(history = true) {
  const rt = fakeRuntime({ realViews: true });
  const env = rt.fakeEnv();
  rt.views.begin();
  const collector = viewsWith({ history }, env);
  return { rt, env, collector };
}

async function finished(rt: ReturnType<typeof fakeRuntime>): Promise<ReadableSpan[]> {
  await rt.flushSpans();
  return rt.exporter.getFinishedSpans().filter((s) => s.name.startsWith("view "));
}

const millis = (t: readonly [number, number]): number => t[0] * 1000 + t[1] / 1e6;

test("the collector is named views", () => {
  assert.equal(setup().collector.name, "views");
});

test("a soft view is a root span linked to its cause and ends after render idle and a paint", async () => {
  const { rt, env, collector } = setup();
  const stop = collector.start(rt);
  const action = rt.tracer.startSpan("action click");
  rt.setActiveAction(action);
  rt.t = 1000;
  env.history.history.pushState(null, "", "/docs/42");
  rt.t = 1050;
  env.mutate(); // the router renders
  env.advance(RENDER_IDLE_MILLIS - 1);
  env.frame();
  assert.equal(
    (await finished(rt)).filter((s) => s.name === "view /docs/$id").length,
    0,
    "a mutation restarted the idle wait",
  );
  env.advance(1);
  env.frame();
  rt.t = 1160;
  env.task();
  action.end();
  const view = (await finished(rt)).find((s) => s.name === "view /docs/$id");
  assert.ok(view);
  assert.equal(view.parentSpanContext, undefined);
  assert.equal(view.links[0]?.context.spanId, action.spanContext().spanId);
  assert.equal(view.attributes["o11y.rum.span.shape"], "view");
  assert.equal(view.attributes["o11y.rum.platform"], "web");
  assert.equal(view.attributes["o11y.rum.view.kind"], "soft");
  assert.equal(view.attributes["o11y.rum.view.name"], "/docs/$id");
  assert.equal(view.attributes["o11y.rum.view.id"], rt.views.current()?.id);
  assert.equal(view.attributes["session.id"], "s1");
  assert.equal(millis(view.startTime), env.timeOrigin + 1000);
  assert.equal(millis(view.endTime), env.timeOrigin + 1160);
  assert.deepEqual(rt.views.current()?.spanContext, view.spanContext());
  stop();
});

test("the initial view span is a child of app_load", async () => {
  const { rt, env, collector } = setup(false);
  const appLoad = rt.tracer.startSpan("app_load");
  rt.views.appLoadStarted(appLoad.spanContext());
  appLoad.end();
  const stop = collector.start(rt);
  rt.t = 300;
  rt.views.rendered();
  env.frame();
  env.task();
  const [view] = await finished(rt);
  assert.equal(view?.name, "view /");
  assert.equal(view?.parentSpanContext?.spanId, appLoad.spanContext().spanId);
  assert.equal(view?.attributes["o11y.rum.view.kind"], "initial");
  assert.equal(millis(view?.startTime ?? [0, 0]), env.timeOrigin);
  assert.equal(millis(view?.endTime ?? [0, 0]), env.timeOrigin + 300);
  stop();
});

test("the initial view span waits for app_load reported later", async () => {
  const { rt, env, collector } = setup(false);
  const stop = collector.start(rt);
  rt.t = 300;
  rt.views.rendered();
  env.frame();
  env.task();
  assert.equal((await finished(rt)).length, 0);
  env.advance(400);
  const appLoad = rt.tracer.startSpan("app_load");
  rt.views.appLoadStarted(appLoad.spanContext());
  env.advance(100);
  const [view] = await finished(rt);
  assert.equal(view?.parentSpanContext?.spanId, appLoad.spanContext().spanId);
  assert.equal(millis(view?.endTime ?? [0, 0]), env.timeOrigin + 300);
  appLoad.end();
  stop();
});

test("without app_load a second after it ended, the initial view span is a root", async () => {
  const { rt, env, collector } = setup(false);
  const stop = collector.start(rt);
  rt.views.rendered();
  env.frame();
  env.task();
  env.advance(999);
  assert.equal((await finished(rt)).length, 0);
  env.advance(1);
  const [view] = await finished(rt);
  assert.ok(view);
  assert.equal(view.parentSpanContext, undefined);
  stop();
});

test("in history mode the initial view renders at the first paint after the load event", async () => {
  const { rt, env, collector } = setup(true);
  rt.views.appLoadStarted(rt.tracer.startSpan("app_load").spanContext());
  const stop = collector.start(rt);
  rt.t = 800;
  env.fireLoad();
  env.frame();
  rt.t = 820;
  env.task();
  const [view] = await finished(rt);
  assert.equal(millis(view?.endTime ?? [0, 0]), env.timeOrigin + 820);
  stop();
});

test("in history mode an initial view of a page that already loaded ends at loadEventEnd", async () => {
  const { rt, env, collector } = setup(true);
  rt.views.appLoadStarted(rt.tracer.startSpan("app_load").spanContext());
  env.loadEventEnd = 640;
  rt.t = 2000;
  const stop = collector.start(rt);
  const [view] = await finished(rt);
  assert.equal(millis(view?.endTime ?? [0, 0]), env.timeOrigin + 640);
  stop();
});

test("a view span ends at the 10 s cap without a render", async () => {
  const { rt, env, collector } = setup(false);
  const stop = collector.start(rt);
  rt.t = 50;
  rt.views.start({ kind: "soft", name: "/slow" });
  env.advance(VIEW_SPAN_CAP_MILLIS - 1);
  assert.equal((await finished(rt)).filter((s) => s.name === "view /slow").length, 0);
  env.advance(1);
  const slow = (await finished(rt)).find((s) => s.name === "view /slow");
  assert.equal(millis(slow?.endTime ?? [0, 0]), env.timeOrigin + 50 + VIEW_SPAN_CAP_MILLIS);
  stop();
});

test("a view that ends first ends its span at once", async () => {
  const { rt, collector } = setup(false);
  const stop = collector.start(rt);
  rt.t = 10;
  rt.views.start({ kind: "soft", name: "/a" });
  rt.t = 30;
  rt.views.start({ kind: "soft", name: "/b" });
  const a = (await finished(rt)).find((s) => s.name === "view /a");
  assert.equal(millis(a?.endTime ?? [0, 0]), rt.fakeEnv().timeOrigin + 30);
  stop();
});

test("a rename renames the open span", async () => {
  const { rt, collector } = setup(false);
  const stop = collector.start(rt);
  rt.views.start({ kind: "soft", name: "/docs/$docId" });
  rt.views.rename("/docs/:id");
  stop();
  const view = (await finished(rt)).find((s) => s.attributes["o11y.rum.view.kind"] === "soft");
  assert.equal(view?.name, "view /docs/:id");
  assert.equal(view?.attributes["o11y.rum.view.name"], "/docs/:id");
});

test("with history off, path changes start no views and nothing renders by itself", async () => {
  const { rt, env, collector } = setup(false);
  const stop = collector.start(rt);
  const initial = rt.views.current()?.id;
  env.history.history.pushState(null, "", "/docs/42");
  env.advance(5000);
  env.fireLoad();
  env.frame();
  env.task();
  assert.equal(rt.views.current()?.id, initial);
  assert.equal((await finished(rt)).length, 0);
  stop();
});

test("a bfcache restore view is a root that ends at the next paint", async () => {
  const { rt, env, collector } = setup(true);
  const stop = collector.start(rt);
  rt.views.start({ kind: "bfcache_restore", name: "/" });
  env.frame();
  env.task();
  const view = (await finished(rt)).find((s) => s.attributes["o11y.rum.view.kind"] === "bfcache_restore");
  assert.ok(view);
  assert.equal(view.parentSpanContext, undefined);
  stop();
});

test("stop ends open spans, uninstalls history and disconnects the observer", async () => {
  const { rt, env, collector } = setup(true);
  const stop = collector.start(rt);
  env.history.history.pushState(null, "", "/a");
  assert.equal(env.observing(), 1);
  rt.t = 70;
  stop();
  assert.equal(env.observing(), 0);
  const before = rt.views.current()?.id;
  env.history.history.pushState(null, "", "/b");
  assert.equal(rt.views.current()?.id, before);
  const spans = await finished(rt);
  assert.deepEqual(spans.map((s) => s.name).sort(), ["view /", "view /a"]);
  env.advance(20_000);
  assert.equal((await finished(rt)).length, 2, "no timer fires after stop");
});

test("with history off, a bfcache restore view still ends at the next paint", async () => {
  const { rt, env, collector } = setup(false);
  const stop = collector.start(rt);
  rt.t = 40;
  rt.views.start({ kind: "bfcache_restore", name: "/" });
  env.frame();
  rt.t = 56;
  env.task();
  const view = (await finished(rt)).find((s) => s.attributes["o11y.rum.view.kind"] === "bfcache_restore");
  assert.equal(millis(view?.endTime ?? [0, 0]), env.timeOrigin + 56);
  stop();
});

test("a view whose content is already on screen ends at the next paint, history on or off", async () => {
  for (const history of [false, true]) {
    const { rt, env, collector } = setup(history);
    const stop = collector.start(rt);
    rt.t = 40;
    rt.views.start({ kind: "soft", name: "/same", rendered: true });
    env.frame();
    rt.t = 52;
    env.task();
    const view = (await finished(rt)).find((s) => s.name === "view /same");
    assert.equal(millis(view?.endTime ?? [0, 0]), env.timeOrigin + 52, `history ${history}`);
    stop();
  }
});

test("a load view the router rendered before RUM started ends when it rendered", async () => {
  const { rt, env, collector } = setup(false);
  rt.views.appLoadStarted(rt.tracer.startSpan("app_load").spanContext());
  rt.t = 5000;
  const stop = collector.start(rt);
  rt.views.rendered(1200);
  const view = (await finished(rt)).find((s) => s.attributes["o11y.rum.view.kind"] === "initial");
  assert.equal(millis(view?.endTime ?? [0, 0]), env.timeOrigin + 1200);
  stop();
});

test("a view that started after the render it is told of ends at the next paint", async () => {
  const { rt, env, collector } = setup(false);
  const stop = collector.start(rt);
  rt.t = 3000;
  rt.views.start({ kind: "soft", name: "/again" });
  rt.views.rendered(1200);
  env.frame();
  rt.t = 3016;
  env.task();
  const view = (await finished(rt)).find((s) => s.name === "view /again");
  assert.equal(millis(view?.endTime ?? [0, 0]), env.timeOrigin + 3016);
  stop();
});

test("a fixed view scope follows no URL change and puts its attributes on every view span", async () => {
  const { rt, env, collector } = setup();
  rt.scope = { fixedView: true, viewAttributes: { "url.domain": "host.test" } };
  const stop = collector.start(rt);
  const first = rt.views.current()?.id;
  env.history.history.pushState(null, "", "/elsewhere");
  env.dispatch("popstate", {});
  assert.equal(rt.views.current()?.id, first, "the view stays");
  rt.views.rendered();
  env.frame();
  env.task();
  env.advance(1000);
  stop();
  const spans = await finished(rt);
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.attributes["url.domain"], "host.test");
});
