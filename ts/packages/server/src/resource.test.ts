import assert from "node:assert/strict";
import { hostname } from "node:os";
import { test } from "node:test";
import type { ResourceDetector } from "@opentelemetry/resources";
import { detectResource, detectResourceWith } from "./resource.ts";
import { clearedOtelEnv, withEnv } from "./test-support/env.ts";

const IS_BUN = "Bun" in globalThis;
const bunVersion = (globalThis as unknown as { Bun?: { version: string } }).Bun?.version;

const NO_CONTAINER: ResourceDetector = { detect: () => ({ attributes: {} }) };

test("detected carries telemetry.sdk.*, the runtime and host.name", async () => {
  const { detected } = await detectResourceWith(true, { container: NO_CONTAINER });
  assert.equal(detected["telemetry.sdk.name"], "opentelemetry");
  assert.equal(detected["telemetry.sdk.language"], "nodejs");
  assert.match(String(detected["telemetry.sdk.version"]), /^\d+\.\d+\.\d+/);
  assert.equal(detected["process.runtime.name"], IS_BUN ? "bun" : "nodejs");
  assert.equal(detected["process.runtime.version"], IS_BUN ? bunVersion : process.versions.node);
  assert.equal(detected["process.runtime.description"], IS_BUN ? "Bun" : "Node.js");
  assert.equal(detected["host.name"], hostname());
});

test("detected never carries the process command, pid or host.id", async () => {
  const { detected } = await detectResourceWith(true, {
    container: { detect: () => ({ attributes: { "container.id": Promise.resolve("c0ffee") } }) },
  });
  for (const key of ["process.command_args", "process.command_line", "process.pid", "host.id"]) {
    assert.equal(key in detected, false, key);
  }
  // Only the keys Go records: the SDK, the runtime, the host name and the container.
  assert.deepEqual(Object.keys(detected).sort(), [
    "container.id",
    "host.name",
    "process.runtime.description",
    "process.runtime.name",
    "process.runtime.version",
    "telemetry.sdk.language",
    "telemetry.sdk.name",
    "telemetry.sdk.version",
  ]);
});

test("container.id is the awaited value of the container detector", async () => {
  const { detected } = await detectResourceWith(true, {
    container: { detect: () => ({ attributes: { "container.id": Promise.resolve("c0ffee") } }) },
  });
  assert.equal(detected["container.id"], "c0ffee");
});

test("an absent or empty container.id is left out, and a failing detector is tolerated", async () => {
  for (const value of [undefined, ""]) {
    const { detected } = await detectResourceWith(true, {
      container: { detect: () => ({ attributes: { "container.id": Promise.resolve(value) } }) },
    });
    assert.equal("container.id" in detected, false, String(value));
  }
  const { detected } = await detectResourceWith(true, {
    container: { detect: () => ({ attributes: { "container.id": Promise.reject(new Error("no cgroup")) } }) },
  });
  assert.equal("container.id" in detected, false);
});

test("the real container detector resolves to a string or nothing", async () => {
  const { detected } = await detectResource(true);
  const id = detected["container.id"];
  assert.ok(id === undefined || (typeof id === "string" && id !== ""), String(id));
});

test("fromEnv reads OTEL_RESOURCE_ATTRIBUTES, and OTEL_SERVICE_NAME wins over its service.name", async () => {
  const layers = await withEnv(
    {
      ...clearedOtelEnv(),
      OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs,deployment.environment.name=staging,k8s.pod.uid=u1",
      OTEL_SERVICE_NAME: "from-name",
    },
    () => detectResourceWith(false, { container: NO_CONTAINER }),
  );
  assert.deepEqual(layers.fromEnv, {
    "service.name": "from-name",
    "deployment.environment.name": "staging",
    "k8s.pod.uid": "u1",
  });
  // The environment never leaks into the detected layer.
  assert.equal("service.name" in layers.detected, false);
});

test("fromEnv takes service.name from OTEL_RESOURCE_ATTRIBUTES when OTEL_SERVICE_NAME is unset", async () => {
  const { fromEnv } = await withEnv(
    { ...clearedOtelEnv(), OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs" },
    () => detectResourceWith(false, { container: NO_CONTAINER }),
  );
  assert.deepEqual(fromEnv, { "service.name": "from-attrs" });
});

test("fromEnv is empty when hermetic", async () => {
  const { fromEnv } = await withEnv(
    { OTEL_RESOURCE_ATTRIBUTES: "service.name=x,a.b=c", OTEL_SERVICE_NAME: "y" },
    () => detectResourceWith(true, { container: NO_CONTAINER }),
  );
  assert.deepEqual(fromEnv, {});
});
