import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { APP_LOAD_CAP_MILLIS } from "./app-start.ts";
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

test("app_load runs from rnStartupTiming.startTime to the first render and parents the load screen", async () => {
  const h = await started(
    { consent: { initial: "granted" } },
    { startupTiming: { startTime: 5 }, loadedAt: 40 },
  );
  h.advance(200);
  h.telemetry.rum.viewRendered();
  await h.idle();
  const appLoad = h.spans().find((s) => s.name === "app_load");
  assert.ok(appLoad, "app_load");
  assert.equal(appLoad.attributes["o11y.rum.span.shape"], "app_load");
  assert.equal(appLoad.attributes["o11y.rum.platform"], "react_native");
  assert.equal(appLoad.attributes["session.id"], h.telemetry.rum.sessionId());
  assert.equal(appLoad.parentSpanId, undefined);
  assert.equal(h.relativeStartMillis(appLoad), 5);
  assert.equal(h.durationMillis(appLoad), 295, "it ends when the first screen rendered");
});

test("the load screen's span is a child of app_load", async () => {
  const h = await started(
    { consent: { initial: "granted" } },
    { startupTiming: { startTime: 5 }, screens: true },
  );
  h.advance(200);
  h.telemetry.rum.viewRendered();
  h.frame();
  await h.idle();
  const appLoad = h.spans().find((s) => s.name === "app_load");
  const view = h.spans().find((s) => s.name === "view app");
  assert.ok(appLoad && view);
  assert.equal(view.parentSpanId, appLoad.spanId);
  assert.equal(view.attributes["o11y.rum.view.kind"], "screen");
  assert.equal(view.attributes["o11y.rum.view.id"], appLoad.attributes["o11y.rum.view.id"]);
});

test("without rnStartupTiming the start is when the package loaded", async () => {
  const h = await started({ consent: { initial: "granted" } }, { loadedAt: 40 });
  h.telemetry.rum.viewRendered();
  await h.idle();
  assert.equal(h.relativeStartMillis(h.spans().find((s) => s.name === "app_load")), 40);
});

test("a start time that is not before now falls back to when the package loaded", async () => {
  const h = await started(
    { consent: { initial: "granted" } },
    { startupTiming: { startTime: 1e9 }, loadedAt: 40 },
  );
  h.telemetry.rum.viewRendered();
  await h.idle();
  assert.equal(h.relativeStartMillis(h.spans().find((s) => s.name === "app_load")), 40);
});

test("a grant after the first render still records the cold start, once per process", async () => {
  const h = await started({ consent: { initial: "pending" } }, { startupTiming: { startTime: 5 } });
  h.advance(200);
  h.telemetry.rum.viewRendered();
  h.advance(30_000);
  h.telemetry.consent.grant();
  await h.idle();
  h.telemetry.consent.revoke();
  await h.idle();
  h.telemetry.consent.grant();
  h.telemetry.rum.viewRendered();
  await h.idle();
  const loads = h.spans().filter((s) => s.name === "app_load");
  assert.equal(loads.length, 1);
  assert.equal(h.relativeStartMillis(loads[0]), 5);
  assert.equal(h.durationMillis(loads[0]), 295, "it ends at the render remembered from before the grant");
});

test("app_load ends at its cap when no render is reported", async () => {
  const h = await started({ consent: { initial: "granted" } }, { startupTiming: { startTime: 0 } });
  h.advance(APP_LOAD_CAP_MILLIS + 1);
  await h.idle();
  assert.equal(h.durationMillis(h.spans().find((x) => x.name === "app_load")), APP_LOAD_CAP_MILLIS);
});

test("a grant after the cap with no render records app_load at its cap", async () => {
  const h = await started({ consent: { initial: "pending" } }, { startupTiming: { startTime: 0 } });
  h.advance(APP_LOAD_CAP_MILLIS + 5000);
  h.telemetry.consent.grant();
  await h.idle();
  assert.equal(h.durationMillis(h.spans().find((x) => x.name === "app_load")), APP_LOAD_CAP_MILLIS);
});

test("shutdown ends an open app_load and sends it", async () => {
  const h = await harness({ consent: { initial: "granted" } }, { startupTiming: { startTime: 0 } });
  h.advance(1000);
  await h.telemetry.shutdown();
  assert.equal(h.durationMillis(h.spans().find((x) => x.name === "app_load")), 1100);
});

test("pending consent records no app_load", async () => {
  const h = await started({ consent: { initial: "pending" } }, { startupTiming: { startTime: 0 } });
  h.telemetry.rum.viewRendered();
  h.advance(APP_LOAD_CAP_MILLIS + 1);
  await h.idle();
  assert.deepEqual(h.spans(), []);
});
