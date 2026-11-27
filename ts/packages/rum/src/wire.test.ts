import assert from "node:assert/strict";
import { test } from "node:test";
import type { HttpTransportOptions } from "@libo11y/web/internal";
import { gatewayTransportOptions, withWireParams } from "./wire.ts";

const NO_ENDPOINTS = { traces: undefined, metrics: undefined, logs: undefined };

test("withWireParams appends sent_at and client_token", () => {
  assert.equal(
    withWireParams("https://g.test/_o11y/v1/logs", "pub 1", 1700000000123),
    "https://g.test/_o11y/v1/logs?sent_at=1700000000123&client_token=pub+1",
  );
  assert.equal(withWireParams("/_o11y/v1/traces?x=1", undefined, 5), "/_o11y/v1/traces?x=1&sent_at=5");
});

test("every fetch and beacon goes to the URL with the parameters of its send time", async () => {
  let t = 10;
  const fetched: string[] = [];
  const beaconed: string[] = [];
  const base: HttpTransportOptions = {
    endpoints: NO_ENDPOINTS,
    fetch: (async (url: string) => {
      fetched.push(url);
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    sendBeacon: (url) => {
      beaconed.push(url);
      return true;
    },
  };
  const o = gatewayTransportOptions(base, "tok", () => t);
  await o.fetch?.("https://g.test/v1/logs", { method: "POST" });
  t = 20;
  o.sendBeacon?.("https://g.test/v1/logs", "{}");
  assert.deepEqual(fetched, ["https://g.test/v1/logs?sent_at=10&client_token=tok"]);
  assert.deepEqual(beaconed, ["https://g.test/v1/logs?sent_at=20&client_token=tok"]);
});

test("an explicitly absent sendBeacon stays absent", () => {
  const o = gatewayTransportOptions({ endpoints: NO_ENDPOINTS, sendBeacon: undefined }, undefined, () => 0);
  assert.ok("sendBeacon" in o);
  assert.equal(o.sendBeacon, undefined);
});
