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

const CTX = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 };

test("rendered emits rendered for the current view", () => {
  const { tracker, events } = setup();
  tracker.rendered();
  assert.equal(events.length, 0, "nothing without a view");
  tracker.begin();
  tracker.rendered();
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "rendered"],
  );
  assert.equal(events[1]?.view.id, tracker.current()?.id);
});

test("appLoad returns the context appLoadStarted reported", () => {
  const { tracker } = setup();
  assert.equal(tracker.appLoad(), undefined);
  tracker.appLoadStarted(CTX);
  assert.deepEqual(tracker.appLoad(), CTX);
});

test("attachSpan records the span context on the current and the load view", () => {
  const { tracker } = setup();
  tracker.begin();
  const id = tracker.current()?.id ?? "";
  tracker.attachSpan("other", CTX);
  assert.equal(tracker.current()?.spanContext, undefined);
  tracker.attachSpan(id, CTX);
  assert.deepEqual(tracker.current()?.spanContext, CTX);
  assert.deepEqual(tracker.loadView()?.spanContext, CTX);
});

test("start passes its cause into the start event", () => {
  const { tracker, events } = setup();
  tracker.begin();
  tracker.start({ kind: "soft", name: "/x", cause: CTX });
  const e = events.at(-1);
  assert.equal(e?.type, "start");
  assert.deepEqual(e?.type === "start" ? e.cause : undefined, CTX);
});

test("begin after an end starts a soft view now, not another initial view", () => {
  let t = 0;
  const summary = createSummaryAccumulator({
    platform: "web",
    emit: () => {},
    now: () => t,
    visible: () => true,
  });
  const tracker = createViewTracker({
    session: fakeSession(),
    summary,
    viewName: defaultViewName,
    location: () => "https://app.test/documents/42",
    now: () => t,
    prerendered: () => false,
  });
  tracker.begin();
  assert.equal(tracker.current()?.kind, "initial");
  t = 60_000;
  tracker.end();
  t = 120_000;
  tracker.begin();
  assert.equal(tracker.current()?.kind, "soft");
  assert.equal(tracker.current()?.startTime, 120_000);
  assert.equal(tracker.loadView()?.kind, "initial", "the load view is still the page's load");
});

test("the soft view a session change starts is already on screen", () => {
  const { tracker, session, events } = setup();
  tracker.begin();
  session.rotate("s2");
  const start = events.at(-1);
  assert.equal(start?.type === "start" && start.rendered, true);
  assert.equal(events[0]?.type === "start" && events[0].rendered, undefined);
});

test("rendered passes the time it rendered at, when given", () => {
  const { tracker, events } = setup();
  tracker.begin();
  tracker.rendered(1200);
  tracker.rendered();
  const rendered = events.filter((e) => e.type === "rendered");
  assert.deepEqual(
    rendered.map((e) => (e.type === "rendered" ? e.at : null)),
    [1200, undefined],
  );
});

test("with a view kind, every view has it: the first begin's is the load view, later ones are not", () => {
  let n = 0;
  const session = fakeSession();
  const tracker = createViewTracker({
    session,
    summary: createSummaryAccumulator({
      platform: "react_native",
      emit: () => {},
      now: () => 0,
      visible: () => true,
    }),
    viewName: () => "app",
    location: () => "app:///",
    now: () => 5,
    prerendered: () => true,
    viewKind: "screen",
    randomId: () => `v${n++}`,
  });
  tracker.begin();
  const first = tracker.current();
  assert.equal(first?.kind, "screen", "the view kind beats prerender");
  assert.equal(first?.startTime, 0);
  assert.equal(tracker.loadView()?.id, first?.id);
  tracker.start({ kind: "screen", name: "/next" });
  assert.equal(tracker.loadView()?.id, first?.id);
  session.rotate("s2");
  assert.equal(tracker.current()?.kind, "screen", "a session change starts a view of the kind");
  tracker.end();
  tracker.begin();
  assert.deepEqual([tracker.current()?.kind, tracker.current()?.name], ["screen", "app"]);
  assert.equal(tracker.loadView()?.id, first?.id, "a later begin is not a load");
});
