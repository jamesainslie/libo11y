import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent, SessionState } from "../contracts/session.ts";
import type { ViewEvent } from "../contracts/views.ts";
import { createSummaryAccumulator } from "../summary/accumulator.ts";
import { defaultViewName } from "./naming.ts";
import { createViewTracker } from "./tracker.ts";

function fakeSession(id = "s1") {
  let state: SessionState | undefined = { id, startedAt: 0, lastActivityAt: 0, sampled: false };
  const listeners = new Set<(e: SessionEvent) => void>();
  return {
    current: () => state,
    subscribe: (l: (e: SessionEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    rotate(next: string) {
      const previous = state;
      state = { id: next, startedAt: 1, lastActivityAt: 1, sampled: false };
      for (const l of listeners)
        l({ type: "start", session: state, ...(previous ? { previous } : {}), local: true });
    },
    clear() {
      state = undefined;
    },
  };
}

function setup(prerendered = false) {
  let n = 0;
  const summaries: Record<string, string | number>[] = [];
  const summary = createSummaryAccumulator({
    platform: "web",
    emit: (a) => summaries.push(a),
    now: () => 0,
    visible: () => true,
  });
  const session = fakeSession();
  const win = new EventTarget();
  const tracker = createViewTracker({
    session,
    summary,
    viewName: defaultViewName,
    location: () => "https://app.test/documents/42",
    now: () => 0,
    prerendered: () => prerendered,
    window: win,
    randomId: () => `v${n++}`,
  });
  const events: ViewEvent[] = [];
  tracker.subscribe((e) => events.push(e));
  return { tracker, summaries, session, win, events };
}

test("begin starts the initial load view named from the URL", () => {
  const { tracker } = setup();
  tracker.begin();
  assert.deepEqual(
    { ...tracker.current(), startTime: undefined },
    { id: "v0", name: "/documents/$id", kind: "initial", sessionId: "s1", startTime: undefined },
  );
  assert.equal(tracker.loadView()?.id, "v0");
});

test("a prerendered page's load view is prerender", () => {
  const { tracker } = setup(true);
  tracker.begin();
  assert.equal(tracker.current()?.kind, "prerender");
});

test("a bfcache restore ends the view and starts a bfcache_restore load view", () => {
  const { tracker, win, summaries } = setup();
  tracker.begin();
  const ev = new Event("pageshow") as Event & { persisted?: boolean };
  ev.persisted = true;
  win.dispatchEvent(ev);
  assert.equal(tracker.current()?.kind, "bfcache_restore");
  assert.equal(tracker.loadView()?.id, "v1");
  assert.equal(summaries.length, 1);
});

test("a first pageshow that is not a restore changes nothing", () => {
  const { tracker, win } = setup();
  tracker.begin();
  win.dispatchEvent(new Event("pageshow"));
  assert.equal(tracker.current()?.id, "v0");
});

test("a session change ends the view and starts a soft view of the same name", () => {
  const { tracker, session, events } = setup();
  tracker.begin();
  session.rotate("s2");
  assert.deepEqual(
    events.map((e) => [e.type, e.view.id, e.view.sessionId, e.view.kind]),
    [
      ["start", "v0", "s1", "initial"],
      ["end", "v0", "s1", "initial"],
      ["start", "v1", "s2", "soft"],
    ],
  );
});

test("rename and end reach the summary", () => {
  const { tracker, summaries } = setup();
  tracker.begin();
  tracker.rename("/documents/$docId");
  tracker.end();
  assert.equal(summaries[0]?.["o11y.rum.view.name"], "/documents/$docId");
  assert.equal(tracker.current(), undefined);
});

test("without a session nothing is tracked", () => {
  const { tracker, session, summaries } = setup();
  session.clear();
  tracker.begin();
  assert.equal(tracker.current(), undefined);
  tracker.end();
  assert.equal(summaries.length, 0);
});
