import assert from "node:assert/strict";
import { test } from "node:test";
import { actionsWith } from "../actions/collector.ts";
import { errorsWith } from "../errors/collector.ts";
import { fakeElement, fakeRuntime } from "../test-support/fake-runtime.ts";
import type { BootstrapBuffer, BootstrapEntry } from "./buffer.ts";
import { replayBootstrap } from "./replay.ts";

const millis = (t: readonly [number, number]): number => t[0] * 1000 + t[1] / 1e6;

function buffer(entries: BootstrapEntry[]): BootstrapBuffer & { stopped: number } {
  const b = {
    entries,
    startedAt: 0,
    stopped: 0,
    stop() {
      b.stopped++;
    },
  };
  return b;
}

function setup() {
  const rt = fakeRuntime({ realViews: true });
  const env = rt.fakeEnv();
  rt.views.begin();
  const stops = [errorsWith({}, { window: env.window }).start(rt), actionsWith({}, env).start(rt)];
  return {
    rt,
    env,
    stop: () => {
      for (const s of stops) s();
    },
  };
}

test("a buffered error is recorded as uncaught at its time", () => {
  const { rt, stop } = setup();
  rt.t = 500;
  const n = replayBootstrap(
    rt,
    buffer([{ kind: "error", at: 40, error: new TypeError("early"), message: "early" }]),
  );
  stop();
  assert.equal(n, 1);
  assert.deepEqual(rt.counts, ["errors.uncaught"]);
  assert.equal(rt.events[0]?.name, "o11y.rum.error");
  assert.equal(rt.events[0]?.attrs["exception.type"], "TypeError");
  assert.ok(rt.signals.some((s) => s.type === "error" && s.at === 40));
});

test("buffered rejections, CSP violations and message-only errors are recorded with their sources", () => {
  const { rt, stop } = setup();
  rt.t = 500;
  replayBootstrap(
    rt,
    buffer([
      { kind: "rejection", at: 10, reason: "nope" },
      { kind: "csp", at: 20, directive: "script-src", blocked: "https://evil.test/x.js?q=1" },
      { kind: "error", at: 30, error: null, message: "Script error." },
    ]),
  );
  stop();
  assert.deepEqual(rt.counts, ["errors.unhandled_rejection", "errors.csp", "errors.uncaught"]);
  assert.equal(rt.events[1]?.attrs["exception.message"], "script-src blocked https://evil.test");
  assert.equal(rt.events[2]?.attrs["exception.message"], "Script error.");
});

test("a buffered click is an instant action span at its time", async () => {
  const { rt, env, stop } = setup();
  rt.t = 500;
  const target = fakeElement({ tagName: "BUTTON", attrs: { "data-o11y": "Sign" } }) as unknown as Element;
  replayBootstrap(rt, buffer([{ kind: "click", at: 42, target }]));
  stop();
  await rt.flushSpans();
  const [span] = rt.exporter.getFinishedSpans().filter((s) => s.name === "action click");
  assert.ok(span);
  assert.equal(millis(span.startTime), env.timeOrigin + 42);
  assert.equal(millis(span.endTime), env.timeOrigin + 42);
  assert.equal(span.attributes["o11y.rum.action.name"], "Sign");
  assert.equal(span.attributes["o11y.rum.element.selector"], '[data-o11y="Sign"]');
  assert.equal(span.attributes["o11y.rum.view.id"], rt.views.current()?.id);
  assert.ok(rt.signals.some((s) => s.type === "breadcrumb" && s.kind === "click" && s.at === 42));
});

test("three buffered clicks on one element within a second are one rage signal", () => {
  const { rt, stop } = setup();
  rt.t = 2000;
  const target = fakeElement({ tagName: "BUTTON", attrs: { id: "go" } }) as unknown as Element;
  replayBootstrap(
    rt,
    buffer([
      { kind: "click", at: 100, target },
      { kind: "click", at: 300, target },
      { kind: "click", at: 500, target },
    ]),
  );
  stop();
  assert.deepEqual(rt.counts, ["frustrations.rage"]);
});

test("replay records nothing while the gate is closed, and stops the buffer either way", () => {
  const { rt, stop } = setup();
  rt.gate.open = false;
  const b = buffer([{ kind: "error", at: 1, error: new Error("x"), message: "x" }]);
  assert.equal(replayBootstrap(rt, b), 0);
  assert.equal(b.stopped, 1);
  assert.equal(replayBootstrap(rt, undefined), 0);
  stop();
  assert.deepEqual(rt.counts, []);
});

test("a collector the app did not install replays nothing of its kind", () => {
  const rt = fakeRuntime({ realViews: true });
  rt.views.begin();
  const stopErrors = errorsWith({}, { window: rt.fakeEnv().window }).start(rt);
  const target = fakeElement({ tagName: "BUTTON" }) as unknown as Element;
  replayBootstrap(rt, buffer([{ kind: "click", at: 1, target }]));
  stopErrors();
  assert.equal(rt.exporter.getFinishedSpans().length, 0);
});
