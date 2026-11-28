/** The React Native Platform core builds on. */
import { type Platform, type RecordingGate, sha1 } from "@libo11y/core";
import {
  browserEnv,
  createContextManager,
  type createExporterSet,
  type Delivery,
  randomUuid,
  type SignalEndpoints,
} from "@libo11y/web/portable";
import type { ReactNativeEnv } from "./contracts/env.ts";
import type { ReactNativeSetupOptions } from "./options.ts";
import { uuidCrypto } from "./random.ts";
import { detectReactNativeResource } from "./resource.ts";

/**
 * OTEL_* defaults suited to a phone, under the options' env: span and log batches every 10 seconds
 * in batches of at most 128, queues of 512, metrics every 60 seconds. Fewer, larger requests save
 * the radio and the JavaScript thread.
 */
export const MOBILE_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  OTEL_BSP_SCHEDULE_DELAY: "10000",
  OTEL_BLRP_SCHEDULE_DELAY: "10000",
  OTEL_BSP_MAX_QUEUE_SIZE: "512",
  OTEL_BLRP_MAX_QUEUE_SIZE: "512",
  OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "128",
  OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: "128",
  OTEL_METRIC_EXPORT_INTERVAL: "60000",
};

/** Options for reactNativePlatform. */
export interface ReactNativePlatformOptions {
  readonly exportOptions: ReactNativeSetupOptions;
  /** The resolved endpoints. */
  readonly endpoints: SignalEndpoints;
  /** The delivery the exporters use. */
  readonly delivery: Delivery;
  /** The consent gate, passed to core as Platform.gate. */
  readonly gate: RecordingGate;
  readonly env: ReactNativeEnv;
  readonly createExporterSet: typeof createExporterSet;
}

/**
 * A React Native Platform, named "react-native": env from browserEnv over MOBILE_ENV_DEFAULTS,
 * detectReactNativeResource, the options' context manager (default upstream's
 * StackContextManager), the exporter set over the delivery, console lines through the console
 * methods captured when the platform is built (so captureConsole cannot recurse), core's own SHA-1
 * (Hermes has no Web Crypto), UUIDs from uuidCrypto, the global console for captureConsole, and
 * the gate. No runtime metrics.
 */
export function reactNativePlatform(o: ReactNativePlatformOptions): Platform {
  const vars = browserEnv(o.exportOptions, o.endpoints, MOBILE_ENV_DEFAULTS);
  const random = uuidCrypto(o.exportOptions.getRandomValues);
  // Bound now, before captureConsole patches the console, so a sink line never re-enters capture.
  const log = console.log.bind(console);
  const warn = console.warn.bind(console);
  return {
    name: "react-native",
    env: () => vars,
    detectResource: (hermetic) => detectReactNativeResource({ env: o.env, hermetic, vars }),
    contextManager: o.exportOptions.contextManager ?? createContextManager,
    buildExporters: (req) => o.createExporterSet(req, o.delivery, o.endpoints),
    writeConsoleLine: (line) => log(line),
    writeDiagnosticLine: (line) => warn(line),
    sha1: async (data) => sha1(data),
    randomUUID: () => randomUuid(random),
    console: globalThis.console,
    gate: o.gate,
  };
}
