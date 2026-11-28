import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNativeSetupOptions } from "../options.ts";
import { memoryStorage } from "../storage/memory.ts";
import { rnHarness } from "../test-support/harness.ts";
import { expoOptionsFrom, withExpoOptions } from "./options.ts";

test("expo options carry the storage, the version, and the update ID and device class as resource attributes", () => {
  const storage = memoryStorage();
  const expo = expoOptionsFrom({ serviceVersion: "1.0.0", updateId: "u-1", deviceClass: "tablet" }, storage);
  assert.equal(expo.storage, storage);
  assert.equal(expo.serviceVersion, "1.0.0");
  assert.deepEqual(expo.resourceAttributes, {
    "o11y.rum.app.update_id": "u-1",
    "o11y.rum.device.class": "tablet",
  });
});

test("an embedded launch with no version gives only the storage", () => {
  const storage = memoryStorage();
  assert.deepEqual(expoOptionsFrom({}, storage), { storage });
});

test("the app's options win, and resourceAttributes merge key by key", () => {
  const storage = memoryStorage();
  const expo = expoOptionsFrom({ serviceVersion: "1.0.0", updateId: "u-1", deviceClass: "tablet" }, storage);
  const own = memoryStorage();
  const merged = withExpoOptions(expo, {
    serviceName: "app",
    serviceVersion: "2.0.0",
    storage: own,
    resourceAttributes: { team: "m", "o11y.rum.device.class": "tv" },
  });
  assert.equal(merged.serviceName, "app");
  assert.equal(merged.serviceVersion, "2.0.0");
  assert.equal(merged.storage, own);
  assert.deepEqual(merged.resourceAttributes, {
    "o11y.rum.app.update_id": "u-1",
    "o11y.rum.device.class": "tv",
    team: "m",
  });
});

test("an option the app leaves undefined does not hide expo's", () => {
  const storage = memoryStorage();
  const merged = withExpoOptions(expoOptionsFrom({ serviceVersion: "1.0.0" }, storage), {
    serviceVersion: undefined,
    storage: undefined,
    // A JavaScript caller, or one without exactOptionalPropertyTypes, can pass undefined.
  } as unknown as ReactNativeSetupOptions);
  assert.equal(merged.serviceVersion, "1.0.0");
  assert.equal(merged.storage, storage);
  assert.equal("resourceAttributes" in merged, false);
});

test("Expo's values yield to the attributes the app sets in env", () => {
  const expo = expoOptionsFrom(
    { serviceVersion: "1.0.0", updateId: "u-1", deviceClass: "mobile" },
    memoryStorage(),
  );
  const merged = withExpoOptions(expo, {
    env: { OTEL_RESOURCE_ATTRIBUTES: "service.version=2.0.0,o11y.rum.device.class=tv" },
  });
  assert.equal(merged.serviceVersion, undefined);
  assert.deepEqual(merged.resourceAttributes, { "o11y.rum.app.update_id": "u-1" });
});

test("a hermetic setup ignores env, so Expo's values stay", () => {
  const expo = expoOptionsFrom({ serviceVersion: "1.0.0", deviceClass: "mobile" }, memoryStorage());
  const merged = withExpoOptions(expo, {
    hermetic: true,
    env: { OTEL_RESOURCE_ATTRIBUTES: "service.version=2.0.0,o11y.rum.device.class=tv" },
  });
  assert.equal(merged.serviceVersion, "1.0.0");
  assert.deepEqual(merged.resourceAttributes, { "o11y.rum.device.class": "mobile" });
});

test("on the built resource, the app's env beats Expo's version and device class", async () => {
  const expo = expoOptionsFrom({ serviceVersion: "1.0.0", deviceClass: "mobile" }, memoryStorage());
  const merged = withExpoOptions(expo, {
    env: { OTEL_RESOURCE_ATTRIBUTES: "service.version=2.0.0,o11y.rum.device.class=tv" },
  });
  // The harness passes serviceVersion "1.0.0" unless told otherwise; this app sets none.
  const h = await rnHarness({ ...merged, serviceVersion: undefined } as unknown as ReactNativeSetupOptions, {
    memory: true,
  });
  assert.equal(h.telemetry.resource.attributes["service.version"], "2.0.0");
  assert.equal(h.telemetry.resource.attributes["o11y.rum.device.class"], "tv");
  await h.telemetry.shutdown();
});

test("resourceAttributes override the detected device class and add the update ID on the built resource", async () => {
  const expo = expoOptionsFrom({ updateId: "u-1", deviceClass: "tablet" }, memoryStorage());
  const h = await rnHarness(withExpoOptions(expo, { consent: { initial: "granted" } }), { memory: true });
  const attrs = h.telemetry.resource.attributes;
  assert.equal(attrs["o11y.rum.device.class"], "tablet");
  assert.equal(attrs["o11y.rum.app.update_id"], "u-1");
  assert.equal(attrs["o11y.rum.platform"], "react_native");
  await h.telemetry.shutdown();
});
