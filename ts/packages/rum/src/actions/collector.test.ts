import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { actionsWith } from "./collector.ts";

function setup(opts: Parameters<typeof actionsWith>[0] = {}) {
  const rt = fakeRuntime({ realViews: true });
  const env = rt.fakeEnv();
  rt.views.begin();
  const stop = actionsWith(opts, env).start(rt);
  return { rt, env, stop };
}

async function actionSpans(rt: ReturnType<typeof fakeRuntime>): Promise<ReadableSpan[]> {
  await rt.flushSpans();
  return rt.exporter.getFinishedSpans().filter((s) => s.name.startsWith("action "));
}

const millis = (t: readonly [number, number]): number => t[0] * 1000 + t[1] / 1e6;

test("the collector is named actions", () => {
  assert.equal(actionsWith({}, fakeRuntime().fakeEnv()).name, "actions");
});

test("a click opens an action span that parents its requests and ends when they settle", async () => {
  const { rt, env, stop } = setup();
  rt.t = 1000;
  env.click({ tagName: "BUTTON", attrs: { "data-o11y": "Sign" } });
  const action = rt.activeAction();
  assert.ok(action);
  rt.t = 1010;
  rt.bus.publish({
    type: "request-start",
    spanId: "r1",
    parentSpanId: action.spanContext().spanId,
    method: "POST",
    url: "https://api.test/sign",
    at: 1010,
  });
  env.advance(300);
  assert.ok(rt.activeAction(), "still open while the request is pending");
  rt.bus.publish({ type: "request-end", spanId: "r1", status: 200, at: 1310 });
  env.advance(99);
  assert.ok(rt.activeAction());
  env.advance(1);
  assert.equal(rt.activeAction(), undefined);
  stop();
  const [span] = await actionSpans(rt);
  assert.equal(span?.name, "action click");
  assert.equal(span?.parentSpanContext, undefined);
  assert.equal(span?.attributes["o11y.rum.span.shape"], "action");
  assert.equal(span?.attributes["o11y.rum.action.type"], "click");
  assert.equal(span?.attributes["o11y.rum.action.name"], "Sign");
  assert.equal(span?.attributes["o11y.rum.element.selector"], '[data-o11y="Sign"]');
  assert.equal(span?.attributes["o11y.rum.view.id"], rt.views.current()?.id);
  assert.equal(millis(span?.startTime ?? [0, 0]), env.timeOrigin + 1000);
  assert.equal(millis(span?.endTime ?? [0, 0]), env.timeOrigin + 1310);
});

test("a request of another action or of none does not hold the action open", async () => {
  const { rt, env, stop } = setup();
  env.click({ tagName: "BUTTON" });
  rt.bus.publish({ type: "request-start", spanId: "x", method: "GET", url: "", at: 0 });
  env.advance(100);
  assert.equal(rt.activeAction(), undefined);
  stop();
});

test("a mutation while the action is open is activity", async () => {
  const { rt, env, stop } = setup({ frustration: false });
  env.click({ tagName: "BUTTON" });
  assert.equal(env.observing(), 1);
  rt.t = 60;
  env.mutate();
  assert.equal(rt.signals.filter((s) => s.type === "mutation").length, 1);
  env.advance(100);
  assert.equal(rt.activeAction(), undefined);
  assert.equal(env.observing(), 0, "the observer disconnects once the action settled");
  stop();
  const [span] = await actionSpans(rt);
  assert.equal(millis(span?.endTime ?? [0, 0]), env.timeOrigin + 60);
});

test("a view start while the action is open is activity", async () => {
  const { rt, env, stop } = setup();
  env.click({ tagName: "A", attrs: { href: "/docs" } });
  rt.t = 40;
  rt.views.start({ kind: "soft", name: "/docs" });
  env.advance(100);
  stop();
  const [span] = await actionSpans(rt);
  assert.equal(millis(span?.endTime ?? [0, 0]), env.timeOrigin + 40);
});

test("a second click ends the first action at its last activity", async () => {
  const { rt, env, stop } = setup();
  env.click({ tagName: "BUTTON" }, 0);
  rt.t = 50;
  env.click({ tagName: "BUTTON" });
  stop();
  const spans = await actionSpans(rt);
  assert.equal(spans.length, 2);
  assert.equal(millis(spans[0]?.endTime ?? [0, 0]), env.timeOrigin);
});

test("an action links to its view span", async () => {
  const { rt, env, stop } = setup();
  const viewSpan = rt.tracer.startSpan("view /");
  rt.views.attachSpan(rt.views.current()?.id ?? "", viewSpan.spanContext());
  env.click({ tagName: "BUTTON" });
  stop();
  const [span] = await actionSpans(rt);
  assert.equal(span?.links[0]?.context.spanId, viewSpan.spanContext().spanId);
});

test("an action without a name has no name attribute and a breadcrumb of its tag", async () => {
  const { rt, env, stop } = setup();
  env.click({ tagName: "BUTTON", id: "save" }, 0);
  stop();
  const [span] = await actionSpans(rt);
  assert.equal(span?.attributes["o11y.rum.action.name"], undefined);
  assert.equal(span?.attributes["o11y.rum.element.selector"], "#save");
  assert.deepEqual(
    rt.signals.filter((s) => s.type === "breadcrumb"),
    [{ type: "breadcrumb", kind: "click", label: "button", at: 0 }],
  );
});

test("the breadcrumb of a named action is its name", () => {
  const { rt, env, stop } = setup();
  env.click({ tagName: "BUTTON", attrs: { "aria-label": "Close" } }, 0);
  stop();
  assert.deepEqual(
    rt.signals.find((s) => s.type === "breadcrumb"),
    { type: "breadcrumb", kind: "click", label: "Close", at: 0 },
  );
});

test("Enter and Space on a control are key_press actions; keys in text fields and other keys are not", async () => {
  const { rt, env, stop } = setup();
  env.key("Enter", { tagName: "BUTTON" });
  env.key(" ", { tagName: "DIV", attrs: { role: "button" } });
  env.key("a", { tagName: "BUTTON" });
  env.key("Enter", { tagName: "INPUT", attrs: { type: "text" } });
  env.key("Enter", { tagName: "TEXTAREA" });
  env.key("Enter", { tagName: "DIV", attrs: { contenteditable: "true" } });
  stop();
  const spans = await actionSpans(rt);
  assert.deepEqual(
    spans.map((s) => s.name),
    ["action key_press", "action key_press"],
  );
  assert.equal(
    JSON.stringify(spans.map((s) => s.attributes)).includes("Enter"),
    false,
    "the key is never recorded",
  );
});

test("a submit is a submit action on the form, unless it follows a click of the same gesture", async () => {
  const { rt, env, stop } = setup();
  env.dispatch("submit", { target: { ...formLike(), tagName: "FORM" }, timeStamp: 0 });
  rt.t = 500;
  env.click({ tagName: "BUTTON", attrs: { type: "submit" } });
  rt.t = 501;
  env.dispatch("submit", { target: formLike(), timeStamp: 501 });
  stop();
  const spans = await actionSpans(rt);
  assert.deepEqual(
    spans.map((s) => s.name),
    ["action submit", "action click"],
  );
});

function formLike() {
  return {
    tagName: "FORM",
    id: "",
    classList: [],
    parentElement: null,
    isContentEditable: false,
    ownerDocument: { getElementById: () => null },
    getAttribute: () => null,
    matches: () => false,
    closest: () => null,
  };
}

test("a click whose target is not an element is ignored", async () => {
  const { rt, env, stop } = setup();
  env.dispatch("click", { target: {}, timeStamp: 0 });
  stop();
  assert.equal((await actionSpans(rt)).length, 0);
});

test("stop ends the open action and removes the listeners", async () => {
  const { rt, env, stop } = setup();
  env.click({ tagName: "BUTTON" });
  stop();
  assert.equal(rt.activeAction(), undefined);
  assert.equal(env.observing(), 0);
  env.click({ tagName: "BUTTON" });
  assert.equal((await actionSpans(rt)).length, 1);
  env.advance(20_000);
  assert.equal(rt.signals.filter((s) => s.type === "frustration").length, 0);
});

test("three fast clicks emit one rage frustration, counted once, retaining the session", async () => {
  const { rt, env, stop } = setup();
  for (const at of [0, 100, 200]) {
    rt.t = at;
    env.click({ tagName: "BUTTON", id: "save" });
    env.mutate();
  }
  stop();
  const rage = rt.events.filter((e) => e.name === "o11y.rum.frustration");
  assert.equal(rage.length, 1);
  assert.equal(rage[0]?.attrs["o11y.rum.frustration.type"], "rage");
  assert.equal(rage[0]?.attrs["o11y.rum.element.selector"], "#save");
  assert.ok(rage[0]?.ctx, "in the open action's context");
  assert.deepEqual(rt.counts, ["frustrations.rage"]);
  assert.deepEqual(rt.retained, ["frustration"]);
  assert.ok(rt.signals.some((s) => s.type === "frustration" && s.frustration === "rage"));
});

test("a click that changes nothing within a second is dead", () => {
  const { rt, env, stop } = setup();
  env.click({ tagName: "BUTTON", id: "nothing" });
  env.advance(1000);
  assert.deepEqual(rt.counts, ["frustrations.dead"]);
  assert.equal(rt.events[0]?.attrs["o11y.rum.frustration.type"], "dead");
  stop();
});

test("a mutation after the action settled but within a second still saves a click from dead", () => {
  const { rt, env, stop } = setup();
  env.click({ tagName: "BUTTON", id: "late" });
  env.advance(500);
  assert.equal(rt.activeAction(), undefined);
  env.mutate();
  env.advance(1000);
  assert.deepEqual(rt.counts, []);
  stop();
});

test("form fields, labels, contenteditable, links and clicks in a selection are never dead", () => {
  const { rt, env, stop } = setup();
  env.click({ tagName: "INPUT", attrs: { type: "checkbox" } });
  env.click({ tagName: "LABEL" });
  env.click({ tagName: "DIV", attrs: { contenteditable: "true" } });
  env.click({ tagName: "A", attrs: { href: "/x" } });
  env.selectionCollapsed = false;
  env.click({ tagName: "BUTTON", id: "b" });
  env.advance(2000);
  assert.deepEqual(rt.counts, []);
  stop();
});

test("an error while an action is open is an error click", () => {
  const { rt, env, stop } = setup({ frustration: true });
  env.click({ tagName: "BUTTON", id: "go" });
  rt.bus.publish({ type: "error", source: "uncaught", at: 5 });
  stop();
  assert.deepEqual(
    rt.counts.filter((c) => c === "frustrations.error"),
    ["frustrations.error"],
  );
});

test("frustration false detects nothing", () => {
  const { rt, env, stop } = setup({ frustration: false });
  for (let i = 0; i < 3; i++) env.click({ tagName: "BUTTON", id: "x" });
  rt.bus.publish({ type: "error", source: "uncaught", at: 0 });
  env.advance(2000);
  assert.deepEqual(rt.counts, []);
  stop();
});

test("an error long after a click, while a key press is open, is not an error click", () => {
  const { rt, env, stop } = setup();
  env.click({ tagName: "BUTTON", id: "save" });
  env.mutate();
  env.advance(20_000);
  env.key("Enter", { tagName: "BUTTON", id: "other" });
  rt.bus.publish({ type: "error", source: "network", at: rt.now() });
  stop();
  assert.deepEqual(
    rt.counts.filter((c) => c === "frustrations.error"),
    [],
  );
});

test("a scope that refuses an event records no action and no frustration for it", async () => {
  const rt = fakeRuntime({ realViews: true });
  const env = rt.fakeEnv();
  rt.views.begin();
  const inside = new Set<unknown>();
  rt.scope = { action: (e) => inside.has(e.target) };
  const stop = actionsWith({}, env).start(rt);
  for (let i = 0; i < 3; i++) env.click({ tagName: "BUTTON", attrs: { "data-o11y": "Host" } });
  env.key("Enter", { tagName: "BUTTON" });
  assert.equal(rt.activeAction(), undefined);
  env.advance(2000);
  assert.deepEqual(rt.counts, [], "no frustration either");
  stop();
  assert.deepEqual(await actionSpans(rt), []);
});
