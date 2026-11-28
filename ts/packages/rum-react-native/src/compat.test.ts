/**
 * The browser adapters take the React Native handle unchanged: `@libo11y/rum-connect` names the
 * fetch spans of Connect calls through rum.onRequestStart, and `@libo11y/rum-react`'s provider and
 * error boundary take telemetry.rum.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { connectRequestNaming } from "@libo11y/rum-connect";
import { RumErrorBoundary, RumProvider } from "@libo11y/rum-react";
import type { ReactElement } from "react";
import { type Harness, harness } from "./test-support/harness.ts";

let open: Harness | undefined;
afterEach(async () => {
  await open?.telemetry.shutdown();
  open = undefined;
});

test("rum-connect names the React Native fetch spans through onRequestStart", async () => {
  const h = await harness({ consent: { initial: "granted" } }, { install: true });
  open = h;
  const off = connectRequestNaming(h.telemetry.rum);
  await h.fetch("https://api.test/lor.portal.v1.SigningService/SignDocument", { method: "POST" });
  off();
  await h.idle();
  const span = h.spans().find((s) => s.attributes["url.full"] !== undefined);
  assert.equal(span?.name, "lor.portal.v1.SigningService/SignDocument");
  assert.equal(span?.scope, "@libo11y/react-native");
  assert.equal(span?.attributes["session.id"], h.telemetry.rum.sessionId());
});

test("rum-react's provider takes the React Native handle, and its error boundary records through it", async () => {
  const h = await harness({ consent: { initial: "granted" } });
  open = h;
  // The provider renders a context provider whose value is the handle, which useRum then reads.
  const provided = RumProvider({ rum: h.telemetry.rum }) as ReactElement<{ value: unknown }>;
  assert.equal(provided.props.value, h.telemetry.rum);
  const boundary = new RumErrorBoundary({ rum: h.telemetry.rum });
  boundary.componentDidCatch(new Error("render failed"), { componentStack: "\n    in Screen" });
  await h.idle();
  const [error] = h.events("o11y.rum.error");
  assert.equal(error?.["o11y.rum.error.source"], "boundary");
  assert.equal(error?.["session.id"], h.telemetry.rum.sessionId());
});
