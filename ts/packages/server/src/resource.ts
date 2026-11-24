/**
 * Server resource detection, in the two layers core merges. The detected layer holds what Go
 * records: the upstream telemetry.sdk.* attributes, the runtime (Bun reports itself as bun, which
 * upstream's processDetector would call nodejs), host.name and container.id. It never holds the
 * process command, command line, pid or host.id. The environment layer comes from upstream's
 * OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME detectors, so OTEL_SERVICE_NAME wins.
 */
import { hostname } from "node:os";
import type { ResourceLayers } from "@libo11y/core";
import type { Attributes, AttributeValue } from "@opentelemetry/api";
import { SDK_INFO } from "@opentelemetry/core";
import { containerDetector } from "@opentelemetry/resource-detector-container";
import {
  type ResourceDetector,
  resourceAttributesEnvDetector,
  serviceNameEnvDetector,
} from "@opentelemetry/resources";

/** The detectors detectResourceWith takes, so tests can replace the container lookup. */
export interface ResourceDetectors {
  readonly container: ResourceDetector;
}

type BunGlobal = { readonly version: string };

function runtimeAttributes(): Attributes {
  const bun = (globalThis as unknown as { Bun?: BunGlobal }).Bun;
  if (bun !== undefined) {
    return {
      "process.runtime.name": "bun",
      "process.runtime.version": bun.version,
      "process.runtime.description": "Bun",
    };
  }
  return {
    "process.runtime.name": "nodejs",
    "process.runtime.version": process.versions.node,
    "process.runtime.description": "Node.js",
  };
}

// settle awaits every attribute a detector returned, dropping undefined, empty strings and values
// whose promise rejected, as upstream's resource merge drops a failed asynchronous attribute.
async function settle(detector: ResourceDetector): Promise<Attributes> {
  const attrs = detector.detect().attributes ?? {};
  const out: Attributes = {};
  await Promise.all(
    Object.entries(attrs).map(async ([key, value]) => {
      try {
        const v = (await value) as AttributeValue | undefined;
        if (v !== undefined && v !== "") out[key] = v;
      } catch {
        // A detector that cannot read its source contributes nothing.
      }
    }),
  );
  return out;
}

/** detectResource with the given detectors. */
export async function detectResourceWith(
  hermetic: boolean,
  detectors: ResourceDetectors,
): Promise<ResourceLayers> {
  const sdk = Object.fromEntries(Object.entries(SDK_INFO).filter(([k]) => k.startsWith("telemetry.sdk.")));
  const detected: Attributes = {
    ...sdk,
    ...runtimeAttributes(),
    "host.name": hostname(),
    ...(await settle(detectors.container)),
  };
  if (hermetic) return { detected, fromEnv: {} };
  const fromEnv: Attributes = {
    ...(await settle(resourceAttributesEnvDetector)),
    ...(await settle(serviceNameEnvDetector)),
  };
  return { detected, fromEnv };
}

/**
 * Detects the server resource layers. fromEnv is empty when hermetic is true, and the container
 * lookup is awaited, so every value is final.
 */
export function detectResource(hermetic: boolean): Promise<ResourceLayers> {
  return detectResourceWith(hermetic, { container: containerDetector });
}
