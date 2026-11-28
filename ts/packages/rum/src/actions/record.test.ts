import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { recordInstantAction } from "./record.ts";

test("an instant action is a zero-length root action span linked to its view", async () => {
  const rt = fakeRuntime({ realViews: true });
  rt.views.begin();
  const viewSpan = rt.tracer.startSpan("view /");
  rt.views.attachSpan(rt.views.current()?.id ?? "", viewSpan.spanContext());
  const outer = rt.tracer.startSpan("outer");
  rt.t = 40;
  recordInstantAction(rt, "custom", "Save");
  await rt.flushSpans();
  const [span] = rt.exporter.getFinishedSpans();
  assert.equal(span?.name, "action custom");
  assert.equal(span?.parentSpanContext, undefined);
  assert.equal(span?.attributes["o11y.rum.span.shape"], "action");
  assert.equal(span?.attributes["o11y.rum.action.type"], "custom");
  assert.equal(span?.attributes["o11y.rum.action.name"], "Save");
  assert.equal(span?.attributes["o11y.rum.view.id"], rt.views.current()?.id);
  assert.equal(span?.links[0]?.context.spanId, viewSpan.spanContext().spanId);
  assert.deepEqual(span?.startTime, span?.endTime);
  assert.deepEqual(rt.signals.at(-1), { type: "breadcrumb", kind: "custom", label: "Save", at: 40 });
  outer.end();
});

test("an unnamed instant action is labelled by its type", () => {
  const rt = fakeRuntime();
  recordInstantAction(rt, "click", undefined, 7);
  assert.deepEqual(rt.signals.at(-1), { type: "breadcrumb", kind: "click", label: "click", at: 7 });
});

test("an instant action is placed on the runtime's clock, not the global performance.timeOrigin", async () => {
  const rt = fakeRuntime();
  rt.timeOrigin = 1_800_000_000_000;
  recordInstantAction(rt, "custom", "Save", 250);
  await rt.flushSpans();
  const [span] = rt.exporter.getFinishedSpans();
  // 1_800_000_000_250 ms is [1_800_000_000 s, 250_000_000 ns].
  assert.deepEqual(span?.startTime, [1_800_000_000, 250_000_000]);
});
