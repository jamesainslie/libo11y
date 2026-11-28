import assert from "node:assert/strict";
import { test } from "node:test";
import { createRouteTracker, type RouteTrackerDefer } from "./tracker.ts";

function fakeRum() {
  const calls: unknown[][] = [];
  return {
    calls,
    startView: (o?: { readonly name?: string }) => {
      calls.push(["startView", o?.name]);
    },
    setViewName: (n: string) => {
      calls.push(["setViewName", n]);
    },
    viewRendered: () => {
      calls.push(["viewRendered"]);
    },
  };
}

/** A defer that runs nothing until flush(), and records cancellations. */
function fakeDefer() {
  const queue: { fn: () => void; cancelled: boolean }[] = [];
  const defer: RouteTrackerDefer = (fn) => {
    const task = { fn, cancelled: false };
    queue.push(task);
    return () => {
      task.cancelled = true;
    };
  };
  const flush = (): void => {
    for (const task of queue.splice(0)) if (!task.cancelled) task.fn();
  };
  return { defer, flush, pending: () => queue.filter((t) => !t.cancelled).length };
}

test("the first report names the current view; a path change starts a screen; each is rendered", () => {
  const rum = fakeRum();
  const d = fakeDefer();
  const t = createRouteTracker(rum, d.defer);
  t.report(["(shop)"], "/");
  d.flush();
  t.report(["(shop)", "items", "[itemId]"], "/items/42");
  d.flush();
  t.report(["(shop)", "items", "[itemId]"], "/items/42");
  d.flush();
  t.report(["(shop)", "items", "[itemId]"], "/items/43");
  d.flush();
  assert.deepEqual(rum.calls, [
    ["setViewName", "/(shop)"],
    ["viewRendered"],
    ["startView", "/(shop)/items/[itemId]"],
    ["viewRendered"],
    ["startView", "/(shop)/items/[itemId]"],
    ["viewRendered"],
  ]);
});

test("viewRendered waits for the deferral, so the commit has settled", () => {
  const rum = fakeRum();
  const d = fakeDefer();
  const t = createRouteTracker(rum, d.defer);
  t.report([], "/");
  assert.deepEqual(rum.calls, [["setViewName", "/"]]);
  assert.equal(d.pending(), 1);
  d.flush();
  assert.deepEqual(rum.calls, [["setViewName", "/"], ["viewRendered"]]);
});

test("a navigation replaced before it rendered is one view, named after the replacement", () => {
  const rum = fakeRum();
  const d = fakeDefer();
  const t = createRouteTracker(rum, d.defer);
  t.report([], "/");
  d.flush();
  t.report(["(app)", "settings"], "/settings");
  t.report(["(auth)", "sign-in"], "/sign-in");
  assert.equal(d.pending(), 1);
  d.flush();
  assert.deepEqual(rum.calls, [
    ["setViewName", "/"],
    ["viewRendered"],
    ["startView", "/(app)/settings"],
    ["setViewName", "/(auth)/sign-in"],
    ["viewRendered"],
  ]);
});

test("a redirect of the first screen renames the initial view and renders it once", () => {
  const rum = fakeRum();
  const d = fakeDefer();
  const t = createRouteTracker(rum, d.defer);
  t.report([], "/");
  t.report(["(auth)", "sign-in"], "/sign-in");
  d.flush();
  assert.deepEqual(rum.calls, [["setViewName", "/"], ["setViewName", "/(auth)/sign-in"], ["viewRendered"]]);
});

test("a redirect back to the rendered path still ends the started view as one", () => {
  const rum = fakeRum();
  const d = fakeDefer();
  const t = createRouteTracker(rum, d.defer);
  t.report(["a"], "/a");
  d.flush();
  t.report(["b"], "/b");
  t.report(["a"], "/a");
  d.flush();
  assert.deepEqual(rum.calls, [
    ["setViewName", "/a"],
    ["viewRendered"],
    ["startView", "/b"],
    ["setViewName", "/a"],
    ["viewRendered"],
  ]);
});

test("the not-found route is named as the router reports it", () => {
  const rum = fakeRum();
  const d = fakeDefer();
  const t = createRouteTracker(rum, d.defer);
  t.report(["+not-found"], "/nowhere/42");
  d.flush();
  assert.deepEqual(rum.calls, [["setViewName", "/+not-found"], ["viewRendered"]]);
});

test("the default defer is a zero-delay timer", async () => {
  const rum = fakeRum();
  const t = createRouteTracker(rum);
  t.report([], "/");
  assert.deepEqual(rum.calls, [["setViewName", "/"]]);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(rum.calls, [["setViewName", "/"], ["viewRendered"]]);
});
