/**
 * The telemetry resource: the platform's detected and environment layers under the explicit options,
 * the tier-0 identity contract, the version fallback, service.instance.id, the sensitivity policy, and
 * one schema URL.
 */
import { ENVIRONMENT_VALUES, SCHEMA_URL } from "@libo11y/spec";
import type { Attributes } from "@opentelemetry/api";
import { type Resource, resourceFromAttributes } from "@opentelemetry/resources";
import { invalidEnvironmentError, noEnvironmentError, noServiceNameError } from "./errors.ts";
import { instanceIdFor } from "./instance-id.ts";
import type { TelemetryOptions } from "./options.ts";
import type { Platform, ResourceLayers } from "./platform.ts";
import { ruleFor, type SensitivityPolicy } from "./policy.ts";

/** The version recorded, and reported by the canary, when none resolves. */
export const SERVICE_VERSION_FALLBACK = "0.0.0-unknown";

/** The resource and what building it found. */
export interface BuiltResource {
  readonly resource: Resource;
  /** Resource violations per rule, for the violation counter once it exists. */
  readonly violations: ReadonlyMap<string, number>;
  /** Whether service.version fell back to 0.0.0-unknown. */
  readonly versionFallback: boolean;
}

function str(attrs: Attributes, key: string): string {
  const v = attrs[key];
  return typeof v === "string" ? v : "";
}

function hasServiceName(attrs: Attributes): boolean {
  const name = str(attrs, "service.name").trim();
  return name !== "" && name !== "unknown_service" && !name.startsWith("unknown_service:");
}

function definedOnly(attrs: Attributes): Attributes {
  return Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined));
}

/**
 * Builds the resource. Layers merge lowest first: detected, then fromEnv, then the explicit layer
 * (the non-blank identity options, then resourceAttributes). Throws NO_SERVICE_NAME, NO_ENVIRONMENT
 * or INVALID_ENVIRONMENT under strict identity; otherwise those become counted violations.
 */
export async function buildResource(
  options: TelemetryOptions,
  layers: ResourceLayers,
  policy: SensitivityPolicy,
  platform: Platform,
): Promise<BuiltResource> {
  const explicit: Record<string, unknown> = {};
  const name = options.serviceName?.trim() ?? "";
  const version = options.serviceVersion?.trim() ?? "";
  const namespace = options.serviceNamespace?.trim() ?? "";
  const environment = options.environment?.trim() ?? "";
  if (name !== "") explicit["service.name"] = name;
  if (version !== "") explicit["service.version"] = version;
  if (namespace !== "") explicit["service.namespace"] = namespace;
  if (environment !== "") explicit["deployment.environment.name"] = environment;
  const attrs: Record<string, unknown> = {
    ...definedOnly(layers.detected),
    ...definedOnly(layers.fromEnv),
    ...explicit,
    ...definedOnly(options.resourceAttributes ?? {}),
  };

  const counts = new Map<string, number>();
  const count = (rule: string): void => {
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  };
  const strict = options.strictIdentity ?? true;
  if (!hasServiceName(attrs)) {
    if (strict) throw noServiceNameError();
    count("identity_service_name");
  }
  const env = str(attrs, "deployment.environment.name");
  const extra = new Set(options.environmentValues ?? []);
  if (env === "") {
    if (strict) throw noEnvironmentError();
    count("identity_environment");
  } else if (!ENVIRONMENT_VALUES.has(env) && !extra.has(env)) {
    if (strict) throw invalidEnvironmentError(env, [...ENVIRONMENT_VALUES, ...extra]);
    count("identity_environment_invalid");
  }

  // As in Go, a non-blank version option counts as resolved even if resourceAttributes blanks it.
  const versionFallback = version === "" && str(attrs, "service.version") === "";
  if (versionFallback) attrs["service.version"] = SERVICE_VERSION_FALLBACK;
  if (str(attrs, "service.instance.id") === "") {
    attrs["service.instance.id"] = await instanceIdFor(
      str(attrs, "k8s.pod.uid"),
      str(attrs, "k8s.pod.name"),
      str(attrs, "k8s.namespace.name"),
      (data) => platform.sha1(data),
      () => platform.randomUUID(),
    );
  }

  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const action = policy.actionFor(key);
    if (action !== "keep") count(ruleFor(policy.classOf(key)));
    if (action === "keep") kept[key] = value;
    // The same bounded rendering as a log record's and a span's, so the token joins across signals.
    else if (action === "rewrite") {
      // No token means the policy holds no usable key: the value is dropped.
      const token = policy.tokenOf(value);
      if (token !== undefined) kept[key] = token;
    }
  }
  return {
    resource: resourceFromAttributes(kept, { schemaUrl: SCHEMA_URL }),
    violations: counts,
    versionFallback,
  };
}
