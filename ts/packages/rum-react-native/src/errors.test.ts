/**
 * errors() through setupRumReactNativeWith over the fakes: an uncaught error reaches the gateway
 * with its breadcrumbs, a rewritten stack and a count in the screen's summary, and a fatal one is
 * sent before React Native's handler runs.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { errorsWith } from "./errors/collector.ts";
import { fakeRn } from "./test-support/fake-rn.ts";
import { type Harness, harness } from "./test-support/harness.ts";

let open: Harness | undefined;
afterEach(async () => {
  await open?.telemetry.shutdown();
  open = undefined;
});

test("an uncaught error carries breadcrumbs and a rewritten stack, and counts in the screen's summary", async () => {
  const rn = fakeRn();
  const h = await harness(
    { consent: { initial: "granted" }, rum: { collectors: [errorsWith(rn.env)] } },
    { screens: true, rumEnv: rn.env },
  );
  open = h;
  h.telemetry.rum.setViewName("/home");
  h.telemetry.rum.viewRendered();
  h.frame();
  h.advance(200);
  const err = new TypeError("undefined is not a function");
  err.stack =
    "TypeError: undefined is not a function\n    at boom (address at /data/app/.expo-internal/7f:1:413)";
  rn.throwGlobal(err, false);
  assert.equal(rn.previousCalls().length, 1);
  h.app.setAppState("background");
  await h.idle();
  const [sent] = h.events("o11y.rum.error");
  assert.equal(sent?.["o11y.rum.error.source"], "uncaught");
  assert.equal(
    sent?.["exception.stacktrace"],
    "TypeError: undefined is not a function\n    at boom (app:///index.android.bundle:1:414)",
  );
  assert.match(String(sent?.["o11y.rum.error.breadcrumbs"]), /\/home/);
  const summary = h.events("o11y.rum.view.summary").find((s) => s["o11y.rum.view.name"] === "/home");
  assert.equal(summary?.["o11y.rum.summary.errors.uncaught"], 1);
});

test("a fatal error is sent, with the screen's summary, before React Native's handler runs", async () => {
  const rn = fakeRn();
  const h = await harness(
    { consent: { initial: "granted" }, rum: { collectors: [errorsWith(rn.env)] } },
    { screens: true, rumEnv: rn.env },
  );
  open = h;
  h.telemetry.rum.viewRendered();
  h.frame();
  await h.idle();
  const before = h.transport.requests.length;
  rn.throwGlobal(new Error("fatal"), true);
  assert.equal(rn.previousCalls().length, 0);
  for (let i = 0; i < 20 && rn.previousCalls().length === 0; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.equal(rn.previousCalls().length, 1, "handed on once the flush finished, before the 2 s cap");
  assert.ok(h.transport.requests.length > before);
  assert.equal(h.events("o11y.rum.error")[0]?.["exception.message"], "fatal");
  const summary = h.events("o11y.rum.view.summary").at(-1);
  assert.equal(summary?.["o11y.rum.summary.errors.uncaught"], 1);
});
