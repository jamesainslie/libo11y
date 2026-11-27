import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeElement, fakeRuntime } from "../test-support/fake-runtime.ts";
import { errorsWith } from "./collector.ts";

function event(type: string, props: Record<string, unknown>): Event {
  const e = new Event(type);
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  return e;
}

test("the collector is named errors", () => {
  assert.equal(errorsWith({}, { window: new EventTarget() }).name, "errors");
});

test("uncaught errors and unhandled rejections are recorded with their sources", () => {
  const rt = fakeRuntime();
  const window = new EventTarget();
  const stop = errorsWith({}, { window }).start(rt);
  const err = new RangeError("out");
  window.dispatchEvent(event("error", { error: err, message: "out" }));
  window.dispatchEvent(event("unhandledrejection", { reason: "nope" }));
  stop();
  window.dispatchEvent(event("error", { error: err, message: "out" }));
  window.dispatchEvent(event("unhandledrejection", { reason: "nope" }));
  assert.deepEqual(rt.counts, ["errors.uncaught", "errors.unhandled_rejection"]);
  assert.equal(rt.events[0]?.attrs["exception.type"], "RangeError");
  assert.equal(rt.events[0]?.attrs["o11y.rum.error.source"], "uncaught");
  assert.equal(rt.events[1]?.attrs["exception.message"], "nope");
  assert.equal(rt.events[1]?.attrs["o11y.rum.error.source"], "unhandled_rejection");
});

test("a cross-origin script error without an error object is recorded from its message", () => {
  const rt = fakeRuntime();
  const window = new EventTarget();
  const stop = errorsWith({}, { window }).start(rt);
  window.dispatchEvent(event("error", { error: null, message: "Script error." }));
  stop();
  assert.equal(rt.events[0]?.attrs["exception.message"], "Script error.");
  assert.equal(rt.events[0]?.attrs["exception.type"], "Error");
});

test("an error event on an element is a resource error without the URL's query", () => {
  const rt = fakeRuntime();
  const window = new EventTarget();
  const stop = errorsWith({}, { window }).start(rt);
  const img = {
    ...fakeElement({ tagName: "IMG" }),
    currentSrc: "",
    src: "https://cdn.test/a.png?sig=secret#x",
  };
  window.dispatchEvent(event("error", { target: img }));
  stop();
  assert.deepEqual(rt.counts, ["errors.resource"]);
  assert.equal(rt.events[0]?.attrs["exception.type"], "ResourceError");
  assert.equal(rt.events[0]?.attrs["exception.message"], "img failed to load: https://cdn.test/a.png");
});

test("a CSP violation names the directive and the blocked origin", () => {
  const rt = fakeRuntime();
  const window = new EventTarget();
  const stop = errorsWith({}, { window }).start(rt);
  window.dispatchEvent(
    event("securitypolicyviolation", {
      effectiveDirective: "img-src",
      blockedURI: "http://localhost:1/x.png?q=1",
    }),
  );
  window.dispatchEvent(
    event("securitypolicyviolation", { effectiveDirective: "script-src", blockedURI: "inline" }),
  );
  stop();
  assert.deepEqual(rt.counts, ["errors.csp", "errors.csp"]);
  assert.equal(rt.events[0]?.attrs["exception.type"], "CSPViolation");
  assert.equal(rt.events[0]?.attrs["exception.message"], "img-src blocked http://localhost:1");
  assert.equal(rt.events[1]?.attrs["exception.message"], "script-src blocked inline");
});

test("a failed request is a network error", () => {
  const rt = fakeRuntime();
  const stop = errorsWith({}, { window: new EventTarget() }).start(rt);
  rt.bus.publish({ type: "request-start", spanId: "r", method: "GET", url: "https://api.test/x?y=1", at: 1 });
  rt.bus.publish({ type: "request-end", spanId: "r", at: 2 });
  rt.bus.publish({ type: "request-start", spanId: "ok", method: "GET", url: "https://api.test/x", at: 3 });
  rt.bus.publish({ type: "request-end", spanId: "ok", status: 500, at: 4 });
  stop();
  assert.deepEqual(rt.counts, ["errors.network"]);
  assert.equal(rt.events[0]?.attrs["exception.type"], "NetworkError");
  assert.equal(rt.events[0]?.attrs["exception.message"], "GET api.test failed");
});

test("console capture records and still calls the original", () => {
  const rt = fakeRuntime();
  const calls: unknown[][] = [];
  const console = { error: (...a: unknown[]) => void calls.push(a) };
  const stop = errorsWith({ console: true }, { window: new EventTarget(), console }).start(rt);
  console.error("bad", 2);
  console.error("failed:", new TypeError("nope"));
  stop();
  console.error("after");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ["bad", 2]);
  assert.deepEqual(calls[2], ["after"]);
  assert.deepEqual(rt.counts, ["errors.console", "errors.console"]);
  assert.equal(rt.events[0]?.attrs["exception.message"], "bad 2");
  assert.equal(rt.events[0]?.attrs["exception.type"], "ConsoleError");
  assert.equal(rt.events[1]?.attrs["exception.message"], "failed: nope");
  assert.equal(rt.events[1]?.attrs["exception.type"], "TypeError");
});

test("console capture is off by default", () => {
  const rt = fakeRuntime();
  const console = { error: (..._a: unknown[]) => {} };
  const original = console.error;
  const stop = errorsWith({}, { window: new EventTarget(), console }).start(rt);
  assert.equal(console.error, original);
  console.error("x");
  stop();
  assert.deepEqual(rt.counts, []);
});

test("stop leaves a console.error someone patched over RUM's in place", () => {
  const rt = fakeRuntime();
  const console = { error: (..._a: unknown[]) => {} };
  const stop = errorsWith({ console: true }, { window: new EventTarget(), console }).start(rt);
  const ours = console.error;
  const theirs = (...a: unknown[]) => ours(...a);
  console.error = theirs;
  stop();
  assert.equal(console.error, theirs);
  console.error("later");
  assert.deepEqual(rt.counts, [], "the wrapper left in the chain records nothing after stop");
});

test("an error logged while recording an error is not recorded again", () => {
  const rt = fakeRuntime();
  const console = { error: (..._a: unknown[]) => {} };
  const stop = errorsWith({ console: true }, { window: new EventTarget(), console }).start(rt);
  rt.bus.subscribe((s) => {
    if (s.type === "error") console.error("inside");
  });
  console.error("outside");
  stop();
  assert.deepEqual(rt.counts, ["errors.console"]);
});
