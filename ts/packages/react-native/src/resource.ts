/**
 * The React Native resource, in the two layers core merges. Detected: upstream's telemetry.sdk.*,
 * o11y.rum.platform react_native, os.name (ios or android, the bounded set the gateway keeps for
 * native apps) and o11y.rum.device.class. fromEnv: OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME
 * from the options' env, parsed as the web platform parses them, and empty when hermetic. Nothing
 * else, so the gateway drops and refuses nothing.
 */
import type { ResourceLayers } from "@libo11y/core";
import { ATTR_RUM_DEVICE_CLASS, ATTR_RUM_PLATFORM, RUM_PLATFORM_VALUE_REACT_NATIVE } from "@libo11y/spec";
import { parseResourceAttributes } from "@libo11y/web/portable";
import type { Attributes } from "@opentelemetry/api";
import { SDK_INFO } from "@opentelemetry/core";
import type { ReactNativeEnv } from "./contracts/env.ts";
import { deviceClassOf } from "./device-class.ts";

const OS_NAMES: ReadonlySet<string> = new Set(["ios", "android"]);

/** What detectReactNativeResource reads. */
export interface ReactNativeResourceOptions {
  readonly env: ReactNativeEnv;
  readonly hermetic: boolean;
  /** The OTEL_* variables, as ReactNativeSetupOptions.env. */
  readonly vars: Readonly<Record<string, string | undefined>>;
}

/** The detected and environment layers of the React Native resource. */
export function detectReactNativeResource(o: ReactNativeResourceOptions): Promise<ResourceLayers> {
  const sdk = Object.fromEntries(Object.entries(SDK_INFO).filter(([k]) => k.startsWith("telemetry.sdk.")));
  const detected: Attributes = {
    ...sdk,
    [ATTR_RUM_PLATFORM]: RUM_PLATFORM_VALUE_REACT_NATIVE,
    ...(OS_NAMES.has(o.env.os) ? { "os.name": o.env.os } : {}),
    [ATTR_RUM_DEVICE_CLASS]: deviceClassOf(o.env),
  };
  if (o.hermetic) return Promise.resolve({ detected, fromEnv: {} });
  const fromEnv: Attributes = parseResourceAttributes(o.vars.OTEL_RESOURCE_ATTRIBUTES);
  const serviceName = o.vars.OTEL_SERVICE_NAME?.trim();
  if (serviceName !== undefined && serviceName !== "") fromEnv["service.name"] = serviceName;
  return Promise.resolve({ detected, fromEnv });
}
