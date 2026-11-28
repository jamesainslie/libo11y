import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeElement, fakeRuntime } from "../test-support/fake-runtime.ts";
import { errorsWith } from "./collector.ts";
import { recordError } from "./record.ts";

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
  const env = rt.fakeEnv();
  const stop = errorsWith(
    { console: true },
    { window: new EventTarget(), console, setTimeout: env.setTimeout },
  ).start(rt);
  console.error("bad", 2);
  console.error("failed:", new TypeError("nope"));
  env.advance(0);
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

test("an aborted request is not a network error", () => {
  const rt = fakeRuntime();
  const stop = errorsWith({}, { window: new EventTarget() }).start(rt);
  for (const [id, errorType] of [
    ["f", "AbortError"],
    ["x", "abort"],
  ] as const) {
    rt.bus.publish({ type: "request-start", spanId: id, method: "GET", url: "https://api.test/x", at: 1 });
    rt.bus.publish({ type: "request-end", spanId: id, errorType, at: 2 });
  }
  rt.bus.publish({ type: "request-start", spanId: "t", method: "GET", url: "https://api.test/x", at: 3 });
  rt.bus.publish({ type: "request-end", spanId: "t", errorType: "timeout", at: 4 });
  stop();
  assert.deepEqual(rt.counts, ["errors.network"]);
});

test("a console.error of an error a boundary records in the same task is recorded once, as boundary", () => {
  // React 19 logs a caught error through console.error before it calls componentDidCatch.
  const rt = fakeRuntime();
  const env = rt.fakeEnv();
  const console = { error: (..._a: unknown[]) => {} };
  const stop = errorsWith(
    { console: true },
    { window: new EventTarget(), console, setTimeout: env.setTimeout },
  ).start(rt);
  const err = new Error("render failed");
  console.error("%o\n\nThe above error occurred in <Doc>", err);
  recordError(rt, "boundary", err, { componentStack: "at Doc" });
  env.advance(0);
  stop();
  assert.deepEqual(rt.counts, ["errors.boundary"]);
  assert.equal(rt.events.length, 1);
});

test("an error recorded before it is logged is not recorded again from console", () => {
  const rt = fakeRuntime();
  const env = rt.fakeEnv();
  const console = { error: (..._a: unknown[]) => {} };
  const stop = errorsWith(
    { console: true },
    { window: new EventTarget(), console, setTimeout: env.setTimeout },
  ).start(rt);
  const err = new Error("handled");
  recordError(rt, "custom", err);
  console.error(err);
  console.error("another", new Error("fresh"));
  env.advance(0);
  stop();
  assert.deepEqual(rt.counts, ["errors.custom", "errors.console"]);
});

test("a console error still pending when the collector stops is dropped", () => {
  const rt = fakeRuntime();
  const env = rt.fakeEnv();
  const console = { error: (..._a: unknown[]) => {} };
  const stop = errorsWith(
    { console: true },
    { window: new EventTarget(), console, setTimeout: env.setTimeout },
  ).start(rt);
  console.error(new Error("late"));
  stop();
  env.advance(0);
  assert.deepEqual(rt.counts, []);
});

test("a console.error of an error object while an error is being recorded is not recorded", () => {
  const rt = fakeRuntime();
  const env = rt.fakeEnv();
  const console = { error: (..._a: unknown[]) => {} };
  const stop = errorsWith(
    { console: true },
    { window: new EventTarget(), console, setTimeout: env.setTimeout },
  ).start(rt);
  rt.bus.subscribe((s) => {
    if (s.type === "error") console.error("exporter failed", new Error("inside"));
  });
  console.error(new Error("outside"));
  env.advance(0);
  env.advance(0);
  stop();
  assert.deepEqual(rt.counts, ["errors.console"]);
});

test("a scope that refuses an error event leaves it unrecorded", () => {
  const rt = fakeRuntime();
  rt.scope = { error: (e) => (e as ErrorEvent).filename?.startsWith("chrome-extension://") === true };
  const window = new EventTarget();
  const stop = errorsWith({}, { window }).start(rt);
  window.dispatchEvent(event("error", { error: new Error("host"), filename: "https://host.test/app.js" }));
  window.dispatchEvent(event("unhandledrejection", { reason: new Error("host") }));
  window.dispatchEvent(
    event("securitypolicyviolation", { effectiveDirective: "img-src", blockedURI: "https://x.test/" }),
  );
  window.dispatchEvent(
    event("error", { error: new Error("mine"), filename: "chrome-extension://id/content.js" }),
  );
  stop();
  assert.deepEqual(rt.counts, ["errors.uncaught"]);
  assert.equal(rt.events[0]?.attrs["exception.message"], "mine");
});
