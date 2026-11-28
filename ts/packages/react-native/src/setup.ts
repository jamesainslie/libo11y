/**
 * setupReactNativeWith: React Native telemetry over its dependencies. setupReactNative, in
 * index.ts, passes the real ones from env.ts, the only module that loads react-native.
 */
import {
  createTelemetryWith,
  O11yError,
  type Platform,
  type SignalReport,
  setupWith,
  type Telemetry,
  type TelemetryOptions,
} from "@libo11y/core";
import {
  type ConsentController,
  type ConsentControllerOptions,
  type createExporterSet,
  type Delivery,
  type DeliveryOptions,
  type HttpTransportOptions,
  OTLP_SIGNALS,
  type PersistentQueue,
  pristineFetch,
  resolveEndpoints,
  type SignalEndpoints,
  type Transport,
} from "@libo11y/web/portable";
import { diag } from "@opentelemetry/api";
import type { AppLifecycle, ReactNativeEnv } from "./contracts/env.ts";
import type { NetworkInstrumentation, NetworkInstrumentationOptions } from "./instrumentation/network.ts";
import type { ReactNativeSetupOptions, ReactNativeTelemetry } from "./options.ts";
import { reactNativePlatform } from "./platform.ts";
import { memoryStorage } from "./storage/memory.ts";
import type { StorageQueueOptions } from "./storage/queue.ts";

/**
 * What setupReactNativeWith builds on. Internal: the default is the real modules and React
 * Native's AppState and Platform (env.ts); tests and @libo11y/rum-react-native's binding replace
 * or wrap any of them.
 */
export interface ReactNativeDeps {
  readonly env: ReactNativeEnv;
  /** When the app is in the foreground. */
  readonly lifecycle: AppLifecycle;
  readonly createConsentController: (opts: ConsentControllerOptions) => ConsentController;
  readonly openQueue: (opts: StorageQueueOptions) => Promise<PersistentQueue>;
  readonly createHttpTransport: (opts: HttpTransportOptions) => Transport;
  readonly createDelivery: (opts: DeliveryOptions) => Delivery;
  readonly createExporterSet: typeof createExporterSet;
  readonly installNetworkInstrumentation: (opts: NetworkInstrumentationOptions) => NetworkInstrumentation;
  /**
   * Observes the platform before core builds on it, with the delivery, the endpoints and the
   * OTEL_* variables it reports, as RUM's binding needs them.
   */
  readonly onPlatform?: (
    platform: Platform,
    info: {
      readonly delivery: Delivery;
      readonly endpoints: SignalEndpoints;
      readonly env: Readonly<Record<string, string>>;
    },
  ) => void;
}

/** The retry queue's mobile bounds: smaller than the browser's 5 MiB and 1000 batches. */
const QUEUE_DEFAULTS = { maxBytes: 2_097_152, maxEntries: 500, maxAgeMillis: 86_400_000 } as const;

/** The lease web's delivery uses for a timeout: three times it, never under 30 seconds. */
const leaseFor = (timeoutMillis: number): number => Math.max(30_000, 3 * timeoutMillis);

/**
 * Refuses an endpoint, from the options or (unless hermetic) the env, that is not an absolute http
 * or https URL: an app has no page to resolve a relative one against.
 */
function requireAbsoluteEndpoints(options: ReactNativeSetupOptions, hermetic: boolean): void {
  const env = hermetic ? {} : (options.env ?? {});
  const candidates = [
    options.endpoint,
    options.tracesEndpoint,
    options.metricsEndpoint,
    options.logsEndpoint,
    env.OTEL_EXPORTER_OTLP_ENDPOINT,
    ...OTLP_SIGNALS.map((s) => env[`OTEL_EXPORTER_OTLP_${s.toUpperCase()}_ENDPOINT`]),
  ];
  for (const raw of candidates) {
    const value = raw?.trim();
    if (value === undefined || value === "") continue;
    let protocol: string | undefined;
    try {
      protocol = new URL(value).protocol;
    } catch {
      protocol = undefined;
    }
    if (protocol !== "http:" && protocol !== "https:") {
      throw new O11yError(
        "INVALID_OPTION",
        `o11y: react-native: endpoint must be an absolute http(s) URL, got ${JSON.stringify(value)}`,
      );
    }
  }
}

/** Runs each cleanup step, reporting a failure through diag and going on. */
async function cleanup(steps: readonly (() => unknown)[]): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      diag.warn("libo11y: react-native: shutdown step failed", err);
    }
  }
}

/**
 * Builds React Native telemetry, installing it globally (providers, propagator, context manager,
 * and the fetch and XHR patches) when install is true. In order: the consent controller (initial
 * state only), the retry queue on options.storage (default memoryStorage(); opening only
 * reads), the endpoints (each an absolute http or https URL, else INVALID_OPTION), the HTTP
 * transport (the pristine fetch, no beacon), the delivery (every batch saved before it is sent,
 * always online), reactNativePlatform, then core with console defaulting to false. The handle is
 * core's Telemetry extended in place with consent and traceFetch.
 *
 * Going to the background flushes every provider; coming back drains the queue. Revoking consent
 * flushes into the closed gate and empties the queue. Shutdown shuts core down, then removes the
 * patches and the lifecycle subscription, shuts the delivery down and closes the queue. After
 * setup the queue is drained once, so batches an earlier launch left go out once consent allows.
 */
export async function setupReactNativeWith(
  options: ReactNativeSetupOptions,
  deps: ReactNativeDeps,
  install: boolean,
): Promise<ReactNativeTelemetry> {
  const hermetic = options.hermetic === true;
  requireAbsoluteEndpoints(options, hermetic);
  const t = options.transport ?? {};
  // Only the initial state: respectDoNotTrack and respectGlobalPrivacyControl stay off, because a
  // React Native runtime has no such signals.
  const controller = deps.createConsentController(
    options.consent?.initial === undefined ? {} : { initial: options.consent.initial },
  );
  const queue = await deps.openQueue({
    storage: options.storage ?? memoryStorage(),
    databaseName: "libo11y",
    maxBytes: t.maxQueueBytes ?? QUEUE_DEFAULTS.maxBytes,
    maxEntries: t.maxQueueEntries ?? QUEUE_DEFAULTS.maxEntries,
    maxAgeMillis: t.maxQueueAgeMillis ?? QUEUE_DEFAULTS.maxAgeMillis,
  });
  const listeners: (() => void)[] = [];
  let delivery: Delivery | undefined;
  let endpoints: SignalEndpoints;
  let telemetry: Telemetry;
  let built: Telemetry | undefined;
  try {
    endpoints = resolveEndpoints(options, hermetic);
    const transport = deps.createHttpTransport({
      endpoints,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(t.timeoutMillis === undefined ? {} : { timeoutMillis: t.timeoutMillis }),
      ...(pristineFetch === undefined ? {} : { fetch: pristineFetch }),
      sendBeacon: undefined,
      isOnline: () => true,
    });
    delivery = deps.createDelivery({
      transport,
      queue,
      gate: controller,
      persistFirst: true,
      mode: () => "normal",
      isOnline: () => true,
      ...(t.initialBackoffMillis === undefined ? {} : { initialBackoffMillis: t.initialBackoffMillis }),
      ...(t.maxBackoffMillis === undefined ? {} : { maxBackoffMillis: t.maxBackoffMillis }),
      ...(t.timeoutMillis === undefined ? {} : { leaseMillis: leaseFor(t.timeoutMillis) }),
    });
    const platform = reactNativePlatform({
      exportOptions: options,
      endpoints,
      delivery,
      gate: controller,
      env: deps.env,
      createExporterSet: deps.createExporterSet,
    });
    deps.onPlatform?.(platform, {
      delivery,
      endpoints,
      env: platform.env() as Readonly<Record<string, string>>,
    });

    const coreOptions: TelemetryOptions = { ...options, console: options.console ?? false };
    telemetry = install
      ? await setupWith(coreOptions, platform)
      : await createTelemetryWith(coreOptions, platform);
    built = telemetry;

    const d = delivery;
    listeners.push(
      deps.lifecycle.subscribe((visible) => {
        if (visible) void d.drain();
        else
          void telemetry
            .forceFlush()
            .catch((err: unknown) => diag.warn("libo11y: react-native: flush failed", err));
      }),
    );
  } catch (err) {
    const d = delivery;
    const b = built;
    // Core first, so a failure after setupWith also releases its globals and ALREADY_SETUP guard.
    await cleanup([() => b?.shutdown(), ...listeners, () => d?.shutdown(), () => queue.close()]);
    throw err;
  }

  const activeDelivery = delivery;
  // Revocation: the gate is already closed, so flushing drains the SDK buffers into it and they
  // are dropped; then the persistent queue is emptied.
  const unregisterRevoke = controller.onRevoke(async () => {
    await telemetry.forceFlush();
    await activeDelivery.clear();
  });
  const uninstalls: (() => void)[] = [];

  // Core's handle extended in place, so identity-keyed lookups such as exemplarStoreOf still work.
  const handle = telemetry as Telemetry & {
    readonly consent: ReactNativeTelemetry["consent"];
    traceFetch: ReactNativeTelemetry["traceFetch"];
  };
  Object.defineProperty(handle, "consent", { value: controller.consent, enumerable: true });
  handle.traceFetch = <F extends typeof fetch>(f: F): F => f;
  const coreShutdown = telemetry.shutdown.bind(telemetry);
  let shutdownPromise: Promise<SignalReport> | undefined;
  handle.shutdown = (opts) => {
    shutdownPromise ??= (async () => {
      const report = await coreShutdown(opts);
      await cleanup([
        ...uninstalls,
        ...listeners,
        unregisterRevoke,
        () => activeDelivery.shutdown(),
        () => queue.close(),
      ]);
      return report;
    })();
    return shutdownPromise;
  };

  if (install) {
    try {
      const instr = options.instrumentations ?? {};
      const net = deps.installNetworkInstrumentation({
        telemetry: handle,
        propagateTo: instr.propagateTo ?? [],
        ignoreUrls: [
          ...(instr.ignoreUrls ?? []),
          ...OTLP_SIGNALS.flatMap((s) => (endpoints[s] === undefined ? [] : [endpoints[s]])),
        ],
        fetch: instr.fetch !== false,
        xhr: instr.xhr !== false,
      });
      uninstalls.push(() => net.uninstall());
      handle.traceFetch = net.traceFetch;
    } catch (err) {
      await handle.shutdown();
      throw err;
    }
  }

  void activeDelivery.drain();
  return handle;
}
