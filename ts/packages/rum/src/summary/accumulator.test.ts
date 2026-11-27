import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_RUM_VIEW_SUMMARY, EVENTS } from "@libo11y/spec";
import { createSummaryAccumulator } from "./accumulator.ts";

const V0 = { id: "v0", name: "/", kind: "initial", sessionId: "s1" } as const;

test("a summary carries every attribute the event contract requires", () => {
  const got: Record<string, string | number>[] = [];
  const acc = createSummaryAccumulator({
    platform: "web",
    emit: (a) => got.push(a),
    now: () => 0,
    visible: () => true,
  });
  acc.open(V0);
  acc.close("v0");
  const required = EVENTS.get(EVENT_RUM_VIEW_SUMMARY)?.required ?? [];
  assert.ok(required.length > 0);
  for (const key of required) assert.ok(key in (got[0] ?? {}), key);
});

test("flush with nothing new sends nothing; reset drops unsent data", () => {
  const got: unknown[] = [];
  let t = 0;
  const acc = createSummaryAccumulator({
    platform: "web",
    emit: (a) => got.push(a),
    now: () => t,
    visible: () => false,
  });
  acc.open(V0);
  acc.flush();
  acc.flush();
  assert.equal(got.length, 1);
  acc.count("errors.custom");
  acc.reset();
  t = 100;
  acc.flush();
  assert.equal(got.length, 1);
});

test("context attributes are added but never override the view identity", () => {
  const got: Record<string, string | number>[] = [];
  const acc = createSummaryAccumulator({
    platform: "web",
    emit: (a) => got.push(a),
    now: () => 0,
    visible: () => true,
    context: () => ({ "o11y.rum.config.version": "c7", "o11y.rum.view.id": "spoofed" }),
  });
  acc.open(V0);
  acc.close("v0");
  assert.equal(got[0]?.["o11y.rum.config.version"], "c7");
  assert.equal(got[0]?.["o11y.rum.view.id"], "v0");
});

test("rename changes the name in later summaries", () => {
  const got: Record<string, string | number>[] = [];
  const acc = createSummaryAccumulator({
    platform: "web",
    emit: (a) => got.push(a),
    now: () => 0,
    visible: () => true,
  });
  acc.open({ ...V0, name: "/documents/123" });
  acc.rename("v0", "/documents/$docId");
  acc.close("v0");
  assert.equal(got[0]?.["o11y.rum.view.name"], "/documents/$docId");
});

test("an eleventh closed view forgets the oldest", () => {
  const got: Record<string, string | number>[] = [];
  const acc = createSummaryAccumulator({
    platform: "web",
    emit: (a) => got.push(a),
    now: () => 0,
    visible: () => true,
  });
  for (let i = 0; i <= 10; i++) {
    acc.open({ ...V0, id: `v${i}` });
    acc.close(`v${i}`);
  }
  got.length = 0;
  acc.vital("v0", "lcp", 1);
  acc.vital("v1", "lcp", 1);
  acc.flush();
  assert.deepEqual(
    got.map((g) => g["o11y.rum.view.id"]),
    ["v1"],
  );
});

test("a count with no open view is dropped", () => {
  const got: Record<string, string | number>[] = [];
  const acc = createSummaryAccumulator({
    platform: "web",
    emit: (a) => got.push(a),
    now: () => 0,
    visible: () => true,
  });
  acc.count("requests");
  acc.open(V0);
  acc.close("v0");
  assert.equal(got[0]?.["o11y.rum.summary.requests"], undefined);
});
