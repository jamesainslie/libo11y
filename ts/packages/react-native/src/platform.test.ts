import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsentController, createDelivery, type ExporterOptions } from "@libo11y/web/portable";
import { createFakeTransport } from "../../web/src/test-support/fake-transport.ts";
import { MOBILE_ENV_DEFAULTS, reactNativePlatform } from "./platform.ts";
import { fakeEnv } from "./test-support/fake-env.ts";

const endpoints = {
  traces: "https://gw.test/v1/traces",
  metrics: undefined,
  logs: "https://gw.test/v1/logs",
};

function platformWith(exportOptions: Parameters<typeof reactNativePlatform>[0]["exportOptions"]) {
  const gate = createConsentController({ initial: "granted" });
  const delivery = createDelivery({ transport: createFakeTransport(), gate });
  const calls: unknown[][] = [];
  const platform = reactNativePlatform({
    exportOptions,
    endpoints,
    delivery,
    gate,
    env: fakeEnv({ os: "ios", isPad: true }),
    createExporterSet: (...args) => {
      calls.push(args);
      return {};
    },
  });
  return { platform, gate, delivery, calls };
}

test("the platform is react-native, with mobile OTEL defaults under the options' env", () => {
  const { platform } = platformWith({ env: { OTEL_BSP_SCHEDULE_DELAY: "250" } });
  assert.equal(platform.name, "react-native");
  const env = platform.env();
  assert.equal(env.OTEL_BSP_SCHEDULE_DELAY, "250");
  assert.equal(env.OTEL_BLRP_SCHEDULE_DELAY, MOBILE_ENV_DEFAULTS.OTEL_BLRP_SCHEDULE_DELAY);
  assert.equal(env.OTEL_METRICS_EXPORTER, "none", "a signal without an endpoint is off");
  assert.deepEqual(MOBILE_ENV_DEFAULTS, {
    OTEL_BSP_SCHEDULE_DELAY: "10000",
    OTEL_BLRP_SCHEDULE_DELAY: "10000",
    OTEL_BSP_MAX_QUEUE_SIZE: "512",
    OTEL_BLRP_MAX_QUEUE_SIZE: "512",
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "128",
    OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: "128",
    OTEL_METRIC_EXPORT_INTERVAL: "60000",
  });
});

test("the resource, the gate, the exporters over the delivery, SHA-1 and UUIDs", async () => {
  const { platform, gate, delivery, calls } = platformWith({ getRandomValues: (a) => a.fill(1) });
  const { detected } = await platform.detectResource(true);
  assert.equal(detected["o11y.rum.device.class"], "tablet");
  assert.equal(platform.gate, gate);
  platform.buildExporters({} as Parameters<typeof platform.buildExporters>[0]);
  assert.equal(calls[0]?.[1], delivery);
  assert.equal(calls[0]?.[2], endpoints);
  assert.deepEqual(calls[0]?.[3] as ExporterOptions | undefined, undefined);
  const digest = await platform.sha1(new TextEncoder().encode("abc"));
  assert.equal(Buffer.from(digest).toString("hex"), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(platform.randomUUID(), "01010101-0101-4101-8101-010101010101");
  assert.equal(platform.console, globalThis.console);
  const cm = platform.contextManager();
  assert.equal(typeof cm.active, "function");
});
