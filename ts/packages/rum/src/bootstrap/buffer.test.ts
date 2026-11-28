import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { manualTimers } from "../test-support/manual-timers.ts";
import {
  afterLoadOn,
  BOOTSTRAP_KEY,
  BOOTSTRAP_MAX_MILLIS,
  bootstrapBuffer,
  installRumBootstrapOn,
  takeBootstrap,
} from "./buffer.ts";

/** An event target that counts its listeners. */
class SpyTarget implements EventTarget {
  added = 0;
  removed = 0;
  readonly inner = new EventTarget();
  addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
    this.added++;
    this.inner.addEventListener(...args);
  }
  removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>): void {
    this.removed++;
    this.inner.removeEventListener(...args);
  }
  dispatchEvent(e: Event): boolean {
    return this.inner.dispatchEvent(e);
  }
}

function fire(target: EventTarget, type: string, props: Record<string, unknown>): void {
  const e = new Event(type);
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  target.dispatchEvent(e);
}

const button = { tagName: "BUTTON", closest: () => null } as unknown as Element;

function install(consent: "pending" | "granted" | undefined, maxEntries?: number) {
  const target = new SpyTarget();
  const clock = manualTimers(100);
  installRumBootstrapOn(
    target,
    { ...(consent === undefined ? {} : { consent }), ...(maxEntries === undefined ? {} : { maxEntries }) },
    { now: clock.now, setTimeout: clock.timers.setTimeout },
  );
  return { target, clock };
}

afterEach(() => {
  takeBootstrap()?.stop();
});

test("pending consent, the default, buffers nothing and adds no listener", () => {
  for (const consent of ["pending", undefined] as const) {
    const { target } = install(consent);
    assert.equal(target.added, 0);
    assert.equal(bootstrapBuffer(), undefined);
  }
});

test("granted consent buffers errors, rejections, CSP violations and clicks in order with their times", () => {
  const { target, clock } = install("granted");
  const err = new Error("early");
  clock.advance(50);
  fire(target, "error", { error: err, message: "early", timeStamp: 120 });
  fire(target, "unhandledrejection", { reason: "nope", timeStamp: 0 });
  fire(target, "securitypolicyviolation", {
    effectiveDirective: "img-src",
    blockedURI: "https://x.test/a.png",
    timeStamp: 999,
  });
  fire(target, "click", { target: button, timeStamp: 140 });
  const b = bootstrapBuffer();
  assert.ok(b);
  assert.equal(b.startedAt, 100);
  assert.deepEqual(b.entries, [
    { kind: "error", at: 120, error: err, message: "early" },
    { kind: "rejection", at: 150, reason: "nope" },
    { kind: "csp", at: 150, directive: "img-src", blocked: "https://x.test/a.png" },
    { kind: "click", at: 140, target: button },
  ]);
});

test("an error event on an element is left to the errors collector", () => {
  const { target } = install("granted");
  fire(target, "error", { target: { tagName: "IMG" }, message: "" });
  assert.deepEqual(bootstrapBuffer()?.entries, []);
});

test("the buffer holds at most maxEntries", () => {
  const { target } = install("granted", 2);
  for (let i = 0; i < 5; i++) fire(target, "click", { target: button });
  assert.equal(bootstrapBuffer()?.entries.length, 2);
});

test("buffering stops after 30 s and the listeners are removed", () => {
  const { target, clock } = install("granted");
  fire(target, "click", { target: button });
  clock.advance(BOOTSTRAP_MAX_MILLIS);
  fire(target, "click", { target: button });
  assert.equal(bootstrapBuffer()?.entries.length, 1);
  assert.equal(target.removed, target.added);
});

test("takeBootstrap returns the buffer once, with its listeners removed", () => {
  const { target } = install("granted");
  const b = takeBootstrap();
  assert.ok(b);
  assert.equal(takeBootstrap(), undefined);
  assert.equal((globalThis as Record<symbol, unknown>)[BOOTSTRAP_KEY], undefined);
  assert.equal(target.removed, target.added);
  fire(target, "click", { target: button });
  assert.equal(b.entries.length, 0);
});

test("a second install keeps the first buffer", () => {
  const first = install("granted");
  const b = bootstrapBuffer();
  const second = install("granted");
  assert.equal(bootstrapBuffer(), b);
  assert.equal(second.target.added, 0);
  assert.ok(first.target.added > 0);
});

test("afterLoad runs at once in an idle callback when the page has loaded, else after load", () => {
  const ran: string[] = [];
  const idle: (() => void)[] = [];
  const win = new EventTarget();
  const doc: { readyState: string } = { readyState: "complete" };
  afterLoadOn({ document: doc, window: win, idle: (cb) => idle.push(cb) }, () => ran.push("loaded page"));
  assert.deepEqual([...ran], []);
  idle.shift()?.();
  assert.deepEqual([...ran], ["loaded page"]);
  doc.readyState = "interactive";
  afterLoadOn({ document: doc, window: win, idle: (cb) => idle.push(cb) }, () => ran.push("later"));
  assert.equal(idle.length, 0);
  win.dispatchEvent(new Event("load"));
  win.dispatchEvent(new Event("load"));
  assert.equal(idle.length, 1);
  idle.shift()?.();
  assert.deepEqual([...ran], ["loaded page", "later"]);
});
