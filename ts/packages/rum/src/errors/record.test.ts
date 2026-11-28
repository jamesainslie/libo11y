import assert from "node:assert/strict";
import { test } from "node:test";
import { trace } from "@opentelemetry/api";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { recordError } from "./record.ts";

test("recordError counts, retains, publishes and emits with breadcrumbs", () => {
  const rt = fakeRuntime();
  rt.crumbs.push("view / -900ms", "click Sign -10ms");
  recordError(rt, "uncaught", new Error("boom"));
  assert.deepEqual(rt.counts, ["errors.uncaught"]);
  assert.deepEqual(rt.retained, ["error"]);
  assert.deepEqual(
    rt.signals.map((s) => s.type),
    ["error"],
  );
  const [ev] = rt.events;
  assert.equal(ev?.name, "o11y.rum.error");
  assert.equal(ev?.attrs["o11y.rum.error.source"], "uncaught");
  assert.equal(ev?.attrs["exception.type"], "Error");
  assert.equal(ev?.attrs["exception.message"], "boom");
  assert.match(String(ev?.attrs["exception.stacktrace"]), /boom/);
  assert.equal(ev?.attrs["o11y.rum.error.breadcrumbs"], "view / -900ms\nclick Sign -10ms");
  assert.equal(ev?.ctx, undefined);
});

test("an error without breadcrumbs has no breadcrumbs attribute", () => {
  const rt = fakeRuntime();
  recordError(rt, "custom", "x");
  assert.equal("o11y.rum.error.breadcrumbs" in (rt.events[0]?.attrs ?? {}), false);
  assert.equal("exception.stacktrace" in (rt.events[0]?.attrs ?? {}), false);
});

test("a component stack follows the stack", () => {
  const rt = fakeRuntime();
  recordError(rt, "boundary", "x", { componentStack: "\n    at Doc\n    at App" });
  assert.equal(rt.events[0]?.attrs["exception.stacktrace"], "\n\n    at Doc\n    at App");
});

test("an error while an action is open is emitted in the action's context", () => {
  const rt = fakeRuntime();
  const action = rt.tracer.startSpan("action click");
  rt.setActiveAction(action);
  recordError(rt, "uncaught", new Error("boom"));
  assert.equal(
    trace.getSpan(rt.events[0]?.ctx ?? ({} as never))?.spanContext().spanId,
    action.spanContext().spanId,
  );
});

test("the error signal carries the time given", () => {
  const rt = fakeRuntime();
  rt.t = 50;
  recordError(rt, "network", "x", { at: 20 });
  recordError(rt, "network", "y");
  assert.deepEqual(
    rt.signals.map((s) => (s.type === "error" ? s.at : -1)),
    [20, 50],
  );
});

test("more than 100 error events per view are counted but not emitted", () => {
  const rt = fakeRuntime();
  for (let i = 0; i < 105; i++) recordError(rt, "console", "x");
  assert.equal(rt.counts.length, 105);
  assert.equal(rt.events.length, 100);
});

test("the event limit starts again on a new view", () => {
  const rt = fakeRuntime({ realViews: true });
  rt.views.begin();
  for (let i = 0; i < 101; i++) recordError(rt, "console", "x");
  rt.views.start({ kind: "soft", name: "/next" });
  recordError(rt, "console", "x");
  assert.equal(rt.events.length, 101);
});

test("the runtime's mapStack rewrites the stack, the component stack included", () => {
  const rt = fakeRuntime();
  rt.mapStack = (s) => s.replaceAll("/tmp/x.js", "app:///main.jsbundle");
  const err = new Error("m");
  err.stack = "Error: m\n    at f (/tmp/x.js:1:5)";
  recordError(rt, "uncaught", err, { componentStack: "\n    at Doc (/tmp/x.js:1:9)" });
  assert.equal(
    rt.events[0]?.attrs["exception.stacktrace"],
    "Error: m\n    at f (app:///main.jsbundle:1:5)\n\n    at Doc (app:///main.jsbundle:1:9)",
  );
});
