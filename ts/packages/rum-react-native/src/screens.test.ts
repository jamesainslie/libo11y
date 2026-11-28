import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runtimeOf, VIEW_SPAN_CAP_MILLIS } from "@libo11y/rum/core";
import { screensWith } from "./screens.ts";
import { type Harness, harness } from "./test-support/harness.ts";

let open: Harness | undefined;
afterEach(async () => {
  await open?.telemetry.shutdown();
  open = undefined;
});

async function started(...args: Parameters<typeof harness>): Promise<Harness> {
  open = await harness(...args);
  return open;
}

test("the screens collector is the views collector", () => {
  assert.equal(
    screensWith({
      loadedAt: 0,
      visible: () => true,
      requestAnimationFrame: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => {},
    }).name,
    "views",
  );
});

test("a later screen's span is a root linked to the tap that caused it, ending at the frame after render", async () => {
  const h = await started({ consent: { initial: "granted" } }, { screens: true });
  h.telemetry.rum.viewRendered();
  h.frame();
  const rt = runtimeOf(h.telemetry);
  const tap = rt?.tracer.startSpan("action tap");
  rt?.setActiveAction(tap);
  h.advance(500);
  h.telemetry.rum.startView({ name: "/(shop)/items/[itemId]" });
  h.advance(30);
  h.telemetry.rum.viewRendered();
  h.advance(4);
  h.frame();
  tap?.end();
  rt?.setActiveAction(undefined);
  await h.idle();
  const later = h.spans().find((s) => s.name === "view /(shop)/items/[itemId]");
  assert.ok(later);
  assert.equal(later.attributes["o11y.rum.view.kind"], "screen");
  assert.equal(later.attributes["o11y.rum.platform"], "react_native");
  assert.equal(later.parentSpanId, undefined);
  assert.deepEqual(later.links, [{ spanId: tap?.spanContext().spanId }]);
  assert.equal(h.durationMillis(later), 34);
});

test("a screen span that never renders ends at 10 seconds", async () => {
  const h = await started({ consent: { initial: "granted" } }, { screens: true });
  h.telemetry.rum.viewRendered();
  h.frame();
  h.telemetry.rum.startView({ name: "/slow" });
  h.advance(VIEW_SPAN_CAP_MILLIS + 1);
  await h.idle();
  assert.equal(h.durationMillis(h.spans().find((s) => s.name === "view /slow")), VIEW_SPAN_CAP_MILLIS);
});

test("in the background a render ends its screen span at the next task, without a frame", async () => {
  const h = await started({ consent: { initial: "granted" } }, { screens: true });
  h.telemetry.rum.viewRendered();
  h.frame();
  h.telemetry.rum.startView({ name: "/away" });
  h.app.setAppState("background");
  h.advance(20);
  h.telemetry.rum.viewRendered();
  h.advance(0);
  await h.idle();
  assert.equal(h.durationMillis(h.spans().find((s) => s.name === "view /away")), 20);
});

test("setViewName names the first screen, as a router adapter does", async () => {
  const h = await started({ consent: { initial: "granted" } }, { screens: true });
  h.telemetry.rum.setViewName("/");
  h.telemetry.rum.viewRendered();
  h.frame();
  await h.idle();
  assert.ok(h.spans().some((s) => s.name === "view /"));
  h.app.setAppState("background");
  await h.idle();
  assert.equal(h.events("o11y.rum.view.summary")[0]?.["o11y.rum.view.name"], "/");
});
