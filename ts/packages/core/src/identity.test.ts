import assert from "node:assert/strict";
import { test } from "node:test";
import { SCHEMA_URL } from "@libo11y/spec";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { O11yError } from "./errors.ts";
import { buildResource } from "./identity.ts";
import type { TelemetryOptions } from "./options.ts";
import type { ResourceLayers } from "./platform.ts";
import { SensitivityPolicy } from "./policy.ts";
import { createTestPlatform } from "./testing.ts";

const platform = createTestPlatform({
  contextManager: () => new AsyncLocalStorageContextManager(),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
});
const dropPolicy = SensitivityPolicy.create({ pii: "drop", registries: [] });
const base: TelemetryOptions = { serviceName: "svc", environment: "test", serviceVersion: "1.2.3" };
const noLayers: ResourceLayers = { detected: {}, fromEnv: {} };

function code(c: string) {
  return (err: unknown) => err instanceof O11yError && err.code === c;
}

test("options beat the environment, which beats detected attributes", async () => {
  const layers: ResourceLayers = {
    detected: {
      "host.name": "detected",
      "telemetry.sdk.language": "nodejs",
      "service.name": "unknown_service",
    },
    fromEnv: { "host.name": "env", "service.name": "env-svc", "service.namespace": "env-ns" },
  };
  const { resource } = await buildResource(
    { ...base, serviceName: "  opt-svc  ", resourceAttributes: { "service.version": "attr-wins" } },
    layers,
    dropPolicy,
    platform,
  );
  const a = resource.attributes;
  assert.equal(a["service.name"], "opt-svc");
  assert.equal(a["host.name"], "env");
  assert.equal(a["service.namespace"], "env-ns");
  assert.equal(a["telemetry.sdk.language"], "nodejs");
  assert.equal(a["service.version"], "attr-wins");
  assert.equal(a["deployment.environment.name"], "test");
  assert.equal(resource.schemaUrl, SCHEMA_URL);
});

test("blank identity options do not override lower layers", async () => {
  const { resource } = await buildResource(
    { serviceName: " ", environment: "", serviceVersion: "\t" },
    { detected: {}, fromEnv: { "service.name": "env-svc", "deployment.environment.name": "staging" } },
    dropPolicy,
    platform,
  );
  assert.equal(resource.attributes["service.name"], "env-svc");
  assert.equal(resource.attributes["deployment.environment.name"], "staging");
});

test("a missing or degenerate service name fails strict identity", async () => {
  for (const name of [undefined, "", "unknown_service", "unknown_service:node", "  unknown_service  "]) {
    const layers: ResourceLayers = {
      detected: name === undefined ? {} : { "service.name": name },
      fromEnv: {},
    };
    await assert.rejects(
      buildResource({ environment: "test" }, layers, dropPolicy, platform),
      code("NO_SERVICE_NAME"),
      String(name),
    );
  }
});

test("a missing environment fails strict identity", async () => {
  await assert.rejects(
    buildResource({ serviceName: "svc" }, noLayers, dropPolicy, platform),
    code("NO_ENVIRONMENT"),
  );
});

test("an environment outside the allowed set fails with the sorted list", async () => {
  await assert.rejects(
    buildResource(
      { serviceName: "svc", environment: "qa", environmentValues: ["perf"] },
      noLayers,
      dropPolicy,
      platform,
    ),
    (err: unknown) =>
      err instanceof O11yError &&
      err.code === "INVALID_ENVIRONMENT" &&
      err.message ===
        'o11y: deployment environment not in the allowed set: "qa" (allowed: development, perf, production, staging, test)',
  );
  const { resource } = await buildResource(
    { serviceName: "svc", environment: "qa", environmentValues: ["qa"] },
    noLayers,
    dropPolicy,
    platform,
  );
  assert.equal(resource.attributes["deployment.environment.name"], "qa");
});

test("without strict identity each problem becomes a counted violation", async () => {
  const missing = await buildResource({ strictIdentity: false }, noLayers, dropPolicy, platform);
  assert.deepEqual([...missing.violations].sort(), [
    ["identity_environment", 1],
    ["identity_service_name", 1],
  ]);
  const invalid = await buildResource(
    { strictIdentity: false, serviceName: "svc", environment: "qa" },
    noLayers,
    dropPolicy,
    platform,
  );
  assert.deepEqual([...invalid.violations], [["identity_environment_invalid", 1]]);
});

test("an unresolved version falls back to 0.0.0-unknown", async () => {
  const built = await buildResource(
    { serviceName: "svc", environment: "test" },
    noLayers,
    dropPolicy,
    platform,
  );
  assert.equal(built.resource.attributes["service.version"], "0.0.0-unknown");
  assert.equal(built.versionFallback, true);
  const fromEnv = await buildResource(
    { serviceName: "svc", environment: "test" },
    { detected: {}, fromEnv: { "service.version": "9.9.9" } },
    dropPolicy,
    platform,
  );
  assert.equal(fromEnv.resource.attributes["service.version"], "9.9.9");
  assert.equal(fromEnv.versionFallback, false);
});

test("service.instance.id derives from pod identity, else the platform uuid, and is kept when set", async () => {
  const pod = await buildResource(
    base,
    { detected: {}, fromEnv: { "k8s.pod.uid": "0f0c5e8e-3b8a-4c1e-9d3a-2f6b7a1c9e42" } },
    dropPolicy,
    platform,
  );
  assert.equal(pod.resource.attributes["service.instance.id"], "fceeac15-05b1-5132-b02a-910f70fb6aac");
  const random = await buildResource(base, noLayers, dropPolicy, platform);
  assert.equal(random.resource.attributes["service.instance.id"], "00000000-0000-4000-8000-000000000000");
  const kept = await buildResource(
    { ...base, resourceAttributes: { "service.instance.id": "mine" } },
    noLayers,
    dropPolicy,
    platform,
  );
  assert.equal(kept.resource.attributes["service.instance.id"], "mine");
});

test("the policy drops or tokenizes resource attributes and counts per rule", async () => {
  const key = new Uint8Array(32).fill(7);
  const policy = SensitivityPolicy.create({ pii: "hash", key, registries: [] });
  const built = await buildResource(
    { ...base, resourceAttributes: { "host.ip": "10.0.0.1", "host.mac": "aa" } },
    { detected: {}, fromEnv: { "http.request.header.authorization": "Bearer x" } },
    policy,
    platform,
  );
  const a = built.resource.attributes;
  assert.equal(a["http.request.header.authorization"], undefined);
  assert.equal(a["host.ip"], policy.tokenOf("10.0.0.1"));
  assert.equal(a["host.mac"], policy.tokenOf("aa"));
  assert.deepEqual([...built.violations].sort(), [
    ["pii_attribute", 2],
    ["secret_attribute", 1],
  ]);
});

test("a PII key from the environment layer never reaches an exported span", async () => {
  const { resource } = await buildResource(
    base,
    { detected: {}, fromEnv: { "host.ip": "10.0.0.1", "deployment.region": "eu" } },
    dropPolicy,
    platform,
  );
  const exporter = new InMemorySpanExporter();
  const tp = new TracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  tp.getTracer("t").startSpan("s").end();
  await tp.forceFlush();
  const [span] = exporter.getFinishedSpans();
  assert.ok(span);
  assert.equal(span.resource.attributes["host.ip"], undefined);
  assert.equal(span.resource.attributes["deployment.region"], "eu");
  assert.equal(span.resource.schemaUrl, SCHEMA_URL);
  await tp.shutdown();
});
