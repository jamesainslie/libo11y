import type { RumTelemetry } from "@libo11y/rum";
import { expect, test } from "@playwright/test";
import { logRecords, spans, startRum } from "../../rum/browser/harness/page.ts";
import { createSink } from "../../web/browser/harness/sink.ts";

type FixtureWindow = { __rum: { telemetry: RumTelemetry } };

const RPC = "lor.signing.v1.SigningService/SignDocument";

test("a Connect RPC's fetch span is named by its method and is the click's child", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await page.route(`**/connect/${RPC}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await startRum(page, "connect-connect", { endpoint: sink.endpoint });
  await page.click('[data-o11y="Sign"]');
  await expect(page.locator("p")).toHaveText("signed");
  await page.waitForTimeout(300);
  await page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum.telemetry.forceFlush());
  const got = await sink.waitFor((r) => spans(r).some((s) => s.name === RPC));
  const rpc = spans(got).find((s) => s.name === RPC);
  const click = spans(got).find(
    (s) => s.name === "action click" && s.attributes["o11y.rum.action.name"] === "Sign",
  );
  expect(rpc?.attributes["rpc.system.name"]).toBe("connectrpc");
  expect(rpc?.attributes["rpc.method"]).toBe(RPC);
  expect(rpc?.attributes["http.request.method"]).toBe("POST");
  expect(click).toBeDefined();
  expect(rpc?.parentSpanId).toBe(click?.spanId);
  // An error afterwards carries the RPC breadcrumb, never the path.
  await page.evaluate(() =>
    (globalThis as unknown as FixtureWindow).__rum.telemetry.rum.addError(new Error("x")),
  );
  await page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum.telemetry.forceFlush());
  const withError = await sink.waitFor((r) => logRecords(r).some((l) => l.eventName === "o11y.rum.error"));
  const crumbs = String(
    logRecords(withError).find((l) => l.eventName === "o11y.rum.error")?.attributes[
      "o11y.rum.error.breadcrumbs"
    ],
  );
  expect(crumbs).toContain(`rpc ${RPC}`);
  expect(crumbs).not.toContain("/connect/");
});
