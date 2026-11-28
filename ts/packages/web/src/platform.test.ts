import assert from "node:assert/strict";
import { test } from "node:test";
import { createTelemetryWith, type ExporterRequest, type ExporterSet } from "@libo11y/core";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { StackContextManager } from "@opentelemetry/sdk-trace";
import type { Delivery, SendMode } from "./contracts/transport.ts";
import { browserEnv, randomUuid, webPlatform, webPlatformWith } from "./platform.ts";
import { createFakeGate } from "./test-support/index.ts";
import type { SignalEndpoints } from "./transport/endpoints.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NO_ENDPOINTS: SignalEndpoints = { traces: undefined, metrics: undefined, logs: undefined };
const ALL_ENDPOINTS: SignalEndpoints = {
  traces: "https://c.example/v1/traces",
  metrics: "https://c.example/v1/metrics",
  logs: "https://c.example/v1/logs",
};

function fakeDelivery(): Delivery {
  return {
    deliver: async () => ({ outcome: "sent" }),
    drain: async () => {},
    clear: async () => {},
    shutdown: async () => {},
  };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("browserEnv defaults to http/json and turns off every signal without an endpoint", () => {
  const env = browserEnv({}, NO_ENDPOINTS);
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, "http/json");
  assert.equal(env.OTEL_TRACES_EXPORTER, "none");
  assert.equal(env.OTEL_METRICS_EXPORTER, "none");
  assert.equal(env.OTEL_LOGS_EXPORTER, "none");
});

test("browserEnv defaults a blank common protocol to http/json", () => {
  const env = browserEnv({ env: { OTEL_EXPORTER_OTLP_PROTOCOL: "  " } }, NO_ENDPOINTS);
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, "http/json");
});

for (const protocol of ["grpc", "http/protobuf"]) {
  test(`webPlatform rejects a common ${protocol} protocol for an OTLP route`, async () => {
    const platform = webPlatform({
      exportOptions: { env: { OTEL_EXPORTER_OTLP_PROTOCOL: protocol } },
      endpoints: { ...NO_ENDPOINTS, traces: ALL_ENDPOINTS.traces },
      delivery: fakeDelivery(),
      gate: createFakeGate(),
    });
    await assert.rejects(
      async () => {
        const telemetry = await createTelemetryWith(
          { serviceName: "shop", environment: "test", console: false },
          platform,
        );
        await telemetry.shutdown();
      },
      { code: "UNSUPPORTED_PROTOCOL" },
    );
  });
}

test("browserEnv leaves a signal with an endpoint to the default otlp route", () => {
  const env = browserEnv({}, { ...NO_ENDPOINTS, traces: "https://c.example/v1/traces" });
  assert.equal("OTEL_TRACES_EXPORTER" in env, false);
  assert.equal(env.OTEL_METRICS_EXPORTER, "none");
  assert.equal(env.OTEL_LOGS_EXPORTER, "none");
  assert.equal("OTEL_TRACES_EXPORTER" in browserEnv({}, ALL_ENDPOINTS), false);
});

test("browserEnv keeps an exporter env names, even without an endpoint", () => {
  const env = browserEnv({ env: { OTEL_TRACES_EXPORTER: "console", OTEL_LOGS_EXPORTER: "" } }, NO_ENDPOINTS, {
    OTEL_METRICS_EXPORTER: "console",
  });
  assert.equal(env.OTEL_TRACES_EXPORTER, "console");
  assert.equal(env.OTEL_METRICS_EXPORTER, "console");
  assert.equal(env.OTEL_LOGS_EXPORTER, "none");
});

test("browserEnv layers envDefaults under exportOptions.env", () => {
  const env = browserEnv(
    { env: { OTEL_BSP_SCHEDULE_DELAY: "250", OTEL_SERVICE_NAME: "shop" } },
    ALL_ENDPOINTS,
    { OTEL_BSP_SCHEDULE_DELAY: "1000", OTEL_BLRP_SCHEDULE_DELAY: "1000" },
  );
  assert.equal(env.OTEL_BSP_SCHEDULE_DELAY, "250");
  assert.equal(env.OTEL_BLRP_SCHEDULE_DELAY, "1000");
  assert.equal(env.OTEL_SERVICE_NAME, "shop");
});

test("webPlatform is named web by default, webext on request, and carries the gate", () => {
  const gate = createFakeGate();
  const p = webPlatform({ exportOptions: {}, endpoints: NO_ENDPOINTS, delivery: fakeDelivery(), gate });
  assert.equal(p.name, "web");
  assert.equal(p.gate, gate);
  assert.equal(p.console, globalThis.console);
  assert.equal(p.startRuntimeMetrics, undefined);
  const x = webPlatform({
    name: "webext",
    exportOptions: {},
    endpoints: NO_ENDPOINTS,
    delivery: fakeDelivery(),
    gate,
  });
  assert.equal(x.name, "webext");
});

test("webPlatform's env is browserEnv of its options", () => {
  const p = webPlatform({
    exportOptions: { env: { OTEL_SERVICE_NAME: "shop" } },
    endpoints: NO_ENDPOINTS,
    delivery: fakeDelivery(),
    gate: createFakeGate(),
    envDefaults: { OTEL_BSP_SCHEDULE_DELAY: "1000" },
  });
  assert.deepEqual(
    p.env(),
    browserEnv({ env: { OTEL_SERVICE_NAME: "shop" } }, NO_ENDPOINTS, { OTEL_BSP_SCHEDULE_DELAY: "1000" }),
  );
});

test("webPlatform detects the browser resource with its env and the userAgent option", async () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "UA/1", language: "de" },
    configurable: true,
    writable: true,
  });
  try {
    const p = webPlatform({
      exportOptions: { userAgent: true, env: { OTEL_SERVICE_NAME: "shop" } },
      endpoints: NO_ENDPOINTS,
      delivery: fakeDelivery(),
      gate: createFakeGate(),
    });
    const layers = await p.detectResource(false);
    assert.equal(layers.detected["browser.language"], "de");
    assert.equal(layers.detected["user_agent.original"], "UA/1");
    assert.deepEqual(layers.fromEnv, { "service.name": "shop" });
    assert.deepEqual((await p.detectResource(true)).fromEnv, {});
    const quiet = webPlatform({
      exportOptions: {},
      endpoints: NO_ENDPOINTS,
      delivery: fakeDelivery(),
      gate: createFakeGate(),
    });
    assert.equal("user_agent.original" in (await quiet.detectResource(false)).detected, false);
  } finally {
    if (nav === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, "navigator", nav);
  }
});

test("webPlatform's context manager is createContextManager unless one is given", () => {
  const p = webPlatform({
    exportOptions: {},
    endpoints: NO_ENDPOINTS,
    delivery: fakeDelivery(),
    gate: createFakeGate(),
  });
  const a = p.contextManager();
  const b = p.contextManager();
  try {
    assert.ok(a instanceof StackContextManager);
    assert.notEqual(a, b);
    assert.equal(a.active(), ROOT_CONTEXT);
  } finally {
    a.disable();
    b.disable();
  }
  const mine = new StackContextManager();
  const q = webPlatform({
    exportOptions: {},
    endpoints: NO_ENDPOINTS,
    delivery: fakeDelivery(),
    gate: createFakeGate(),
    contextManager: () => mine,
  });
  assert.equal(q.contextManager(), mine);
});

test("buildExporters hands the request, delivery, endpoints and mode to the exporter set", () => {
  const delivery = fakeDelivery();
  const mode = (): SendMode => "unload";
  const set: ExporterSet = {};
  const calls: unknown[][] = [];
  const p = webPlatformWith(
    { exportOptions: {}, endpoints: ALL_ENDPOINTS, delivery, gate: createFakeGate(), mode },
    {
      createExporterSet: (...args) => {
        calls.push(args);
        return set;
      },
    },
  );
  const req = { config: {}, exemplars: {} } as unknown as ExporterRequest;
  assert.equal(p.buildExporters(req), set);
  assert.equal(calls.length, 1);
  const [r, d, e, o] = calls[0] as [unknown, unknown, unknown, { mode: () => SendMode }];
  assert.equal(r, req);
  assert.equal(d, delivery);
  assert.equal(e, ALL_ENDPOINTS);
  assert.equal(o.mode(), "unload");
});

test("buildExporters defaults the mode to normal", () => {
  let seen: (() => SendMode) | undefined;
  const p = webPlatformWith(
    { exportOptions: {}, endpoints: ALL_ENDPOINTS, delivery: fakeDelivery(), gate: createFakeGate() },
    {
      createExporterSet: (_r, _d, _e, o) => {
        seen = o?.mode;
        return {};
      },
    },
  );
  p.buildExporters({ config: {}, exemplars: {} } as unknown as ExporterRequest);
  assert.equal(seen?.(), "normal");
});

test("sha1 digests by Web Crypto", async () => {
  const p = webPlatform({
    exportOptions: {},
    endpoints: NO_ENDPOINTS,
    delivery: fakeDelivery(),
    gate: createFakeGate(),
  });
  assert.equal(
    hex(await p.sha1(new TextEncoder().encode("abc"))),
    "a9993e364706816aba3e25717850c26c9cd0d89d",
  );
  assert.equal(hex(await p.sha1(new Uint8Array())), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
});

test("webPlatform derives the pod instance ID without crypto.subtle", async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  assert.ok(cryptoDescriptor);
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) },
  });
  try {
    const platform = webPlatform({
      exportOptions: {
        env: { OTEL_RESOURCE_ATTRIBUTES: "k8s.pod.uid=0f0c5e8e-3b8a-4c1e-9d3a-2f6b7a1c9e42" },
      },
      endpoints: NO_ENDPOINTS,
      delivery: fakeDelivery(),
      gate: createFakeGate(),
    });
    const telemetry = await createTelemetryWith(
      { serviceName: "shop", environment: "test", console: false },
      platform,
    );
    try {
      assert.equal(
        telemetry.resource.attributes["service.instance.id"],
        "fceeac15-05b1-5132-b02a-910f70fb6aac",
      );
    } finally {
      await telemetry.shutdown();
    }
  } finally {
    Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
  }
});

test("randomUUID gives lowercase v4 UUIDs", () => {
  const p = webPlatform({
    exportOptions: {},
    endpoints: NO_ENDPOINTS,
    delivery: fakeDelivery(),
    gate: createFakeGate(),
  });
  const a = p.randomUUID();
  assert.match(a, UUID_V4);
  assert.notEqual(a, p.randomUUID());
});

test("randomUuid falls back to getRandomValues without crypto.randomUUID", () => {
  let calls = 0;
  const noRandomUUID = {
    getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
      calls++;
      return crypto.getRandomValues(array);
    },
  };
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) {
    const id = randomUuid(noRandomUUID);
    assert.match(id, UUID_V4);
    seen.add(id);
  }
  assert.equal(seen.size, 64);
  assert.equal(calls, 64);
  const fixed = randomUuid({
    getRandomValues: (array: Uint8Array<ArrayBuffer>) => array.fill(0xff),
  });
  assert.equal(fixed, "ffffffff-ffff-4fff-bfff-ffffffffffff");
});

test("randomUuid prefers crypto.randomUUID", () => {
  assert.equal(
    randomUuid({
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
      getRandomValues: () => {
        throw new Error("not used");
      },
    }),
    "00000000-0000-4000-8000-000000000000",
  );
});

test("console lines go through the console methods captured at build, so capture cannot recurse", async () => {
  const original = { log: console.log, warn: console.warn };
  const logged: unknown[][] = [];
  const warned: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    logged.push(args);
  };
  console.warn = (...args: unknown[]) => {
    warned.push(args);
  };
  try {
    const p = webPlatform({
      exportOptions: {},
      endpoints: NO_ENDPOINTS,
      delivery: fakeDelivery(),
      gate: createFakeGate(),
    });
    const telemetry = await createTelemetryWith(
      {
        serviceName: "t",
        environment: "test",
        hermetic: true,
        captureConsole: true,
        console: "json",
        startupSummary: false,
      },
      p,
    );
    try {
      console.log("hello %s", "there");
      assert.equal(logged.length, 1);
      const line = JSON.parse(String(logged[0]?.[0])) as Record<string, unknown>;
      assert.equal(line.msg, "hello there");
      p.writeDiagnosticLine("level=WARN msg=x");
      assert.deepEqual(warned, [["level=WARN msg=x"]]);
    } finally {
      await telemetry.shutdown();
    }
  } finally {
    console.log = original.log;
    console.warn = original.warn;
  }
});
