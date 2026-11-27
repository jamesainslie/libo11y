import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { watchHistory } from "./history.ts";

function host(start: string) {
  const h = fakeRuntime().fakeEnv().history;
  h.location.href = start;
  return h;
}

test("path changes start views; query and fragment changes do not", () => {
  const h = host("https://app.test/a");
  const seen: string[] = [];
  const off = watchHistory(h, (u) => seen.push(u.pathname));
  h.history.pushState(null, "", "/b");
  h.history.pushState(null, "", "/b?x=1#y");
  h.history.replaceState(null, "", "/c");
  h.pop("https://app.test/a");
  off();
  h.history.pushState(null, "", "/d");
  assert.deepEqual(seen, ["/b", "/c", "/a"]);
});

test("uninstall leaves a later patch in place", () => {
  const h = host("https://app.test/a");
  const seen: string[] = [];
  const off = watchHistory(h, (u) => seen.push(u.pathname));
  const ours = h.history.pushState;
  const calls: string[] = [];
  h.history.pushState = function (this: History, ...args: Parameters<History["pushState"]>) {
    calls.push("app");
    ours.apply(this, args);
  };
  off();
  h.history.pushState(null, "", "/b");
  assert.deepEqual(calls, ["app"]);
  assert.deepEqual(seen, [], "the wrapper left in the chain reports nothing after uninstall");
  assert.equal(h.location.href, "https://app.test/b");
});

test("the original methods run with the history as this", () => {
  const h = host("https://app.test/a");
  const self: unknown[] = [];
  const original = h.history.pushState;
  h.history.pushState = function (this: unknown, ...args: Parameters<History["pushState"]>) {
    self.push(this);
    original.apply(h.history as History, args);
  };
  const off = watchHistory(h, () => {});
  h.history.pushState(null, "", "/b");
  off();
  assert.equal(self[0], h.history);
});
