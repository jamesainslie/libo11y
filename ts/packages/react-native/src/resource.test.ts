import assert from "node:assert/strict";
import { test } from "node:test";
import { detectReactNativeResource } from "./resource.ts";
import { fakeEnv } from "./test-support/fake-env.ts";

test("the detected layer names the platform, the OS and the device class, and the SDK", async () => {
  const { detected, fromEnv } = await detectReactNativeResource({
    env: fakeEnv({ os: "ios" }),
    hermetic: false,
    vars: {},
  });
  assert.equal(detected["o11y.rum.platform"], "react_native");
  assert.equal(detected["os.name"], "ios");
  assert.equal(detected["o11y.rum.device.class"], "mobile");
  assert.equal(detected["telemetry.sdk.language"], "javascript");
  assert.equal(detected["telemetry.sdk.name"], "opentelemetry");
  assert.equal(typeof detected["telemetry.sdk.version"], "string");
  assert.deepEqual(fromEnv, {});
});

test("an OS other than iOS and Android gives no os.name", async () => {
  const { detected } = await detectReactNativeResource({
    env: fakeEnv({ os: "windows" }),
    hermetic: false,
    vars: {},
  });
  assert.equal(detected["os.name"], undefined);
  assert.equal("os.name" in detected, false);
});

test("OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME fill fromEnv", async () => {
  const { fromEnv } = await detectReactNativeResource({
    env: fakeEnv({ os: "android" }),
    hermetic: false,
    vars: { OTEL_RESOURCE_ATTRIBUTES: "team=mobile", OTEL_SERVICE_NAME: " app " },
  });
  assert.equal(fromEnv.team, "mobile");
  assert.equal(fromEnv["service.name"], "app");
});

test("hermetic mode reads no variables", async () => {
  const { fromEnv } = await detectReactNativeResource({
    env: fakeEnv(),
    hermetic: true,
    vars: { OTEL_SERVICE_NAME: "x", OTEL_RESOURCE_ATTRIBUTES: "a=b" },
  });
  assert.deepEqual(fromEnv, {});
});
