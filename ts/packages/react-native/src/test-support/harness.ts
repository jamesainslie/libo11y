/**
 * setupReactNativeWith over fakes: the fake env and storage, web's fake transport, and the real
 * consent controller, storage queue, delivery (whose retry timer never fires, so only explicit
 * drains send) and exporter set. Never built.
 */
import type { Platform } from "@libo11y/core";
import {
  createConsentController,
  createDelivery,
  createExporterSet,
  type DeliveryOptions,
  type HttpTransportOptions,
  type PersistentQueue,
  type SendRequest,
} from "@libo11y/web/portable";
import { createFakeTransport, type FakeTransport } from "../../../web/src/test-support/fake-transport.ts";
import type { NetworkInstrumentationOptions } from "../instrumentation/network.ts";
import { appStateLifecycle } from "../lifecycle.ts";
import type { ReactNativeSetupOptions, ReactNativeTelemetry } from "../options.ts";
import { type ReactNativeDeps, setupReactNativeWith } from "../setup.ts";
import { openStorageQueue, type StorageQueueOptions } from "../storage/queue.ts";
import { type FakeEnv, fakeEnv } from "./fake-env.ts";
import { type FakeStorage, fakeStorage } from "./fake-storage.ts";

export interface Harness {
  readonly telemetry: ReactNativeTelemetry;
  readonly env: FakeEnv;
  readonly storage: FakeStorage;
  readonly transport: FakeTransport;
  /** The queue openQueue opened. */
  queue(): PersistentQueue;
  readonly queueOptions: StorageQueueOptions[];
  readonly transportOptions: HttpTransportOptions[];
  readonly deliveryOptions: DeliveryOptions[];
  readonly network: { readonly installs: NetworkInstrumentationOptions[]; uninstalls: number };
  /** What onPlatform saw. */
  readonly platform: { value?: Platform; env?: Readonly<Record<string, string>> };
  /** The requests of one signal the transport received. */
  sent(signal?: SendRequest["signal"]): SendRequest[];
  /** Ends a span named name on the telemetry's tracer. */
  span(name: string): void;
}

/** Resolves once cond() holds, polling on macrotasks, or rejects after timeoutMillis. */
export async function until(cond: () => boolean, timeoutMillis = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMillis;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Lets every pending microtask and a few macrotasks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Where the fake network's traceFetch keeps the fetch it wrapped. */
export const TRACE_NETWORK: unique symbol = Symbol("traceFetch of the fake network");

export async function rnHarness(
  options: ReactNativeSetupOptions = {},
  o: {
    readonly install?: boolean;
    readonly deps?: Partial<ReactNativeDeps>;
    readonly storage?: FakeStorage;
    /** Pass no storage, so setup uses memoryStorage(). */
    readonly memory?: boolean;
  } = {},
): Promise<Harness> {
  const env = fakeEnv();
  const storage = o.storage ?? fakeStorage();
  const transport = createFakeTransport();
  let queue: PersistentQueue | undefined;
  const queueOptions: StorageQueueOptions[] = [];
  const transportOptions: HttpTransportOptions[] = [];
  const deliveryOptions: DeliveryOptions[] = [];
  const network = { installs: [] as NetworkInstrumentationOptions[], uninstalls: 0 };
  const platform: Harness["platform"] = {};
  const deps: ReactNativeDeps = {
    env,
    lifecycle: appStateLifecycle(env.appState),
    createConsentController,
    openQueue: async (q) => {
      queueOptions.push(q);
      queue = await openStorageQueue(q);
      return queue;
    },
    createHttpTransport: (t) => {
      transportOptions.push(t);
      return transport;
    },
    createDelivery: (d) => {
      deliveryOptions.push(d);
      return createDelivery({ ...d, setTimer: () => 0, clearTimer: () => {} });
    },
    createExporterSet,
    installNetworkInstrumentation: (n) => {
      network.installs.push(n);
      return {
        uninstall: () => {
          network.uninstalls++;
        },
        traceFetch: <F extends typeof fetch>(f: F): F =>
          Object.assign(((...a: Parameters<typeof fetch>) => f(...a)) as F, { [TRACE_NETWORK]: f }),
      };
    },
    onPlatform: (p, info) => {
      platform.value = p;
      platform.env = info.env;
    },
    ...o.deps,
  };
  const telemetry = await setupReactNativeWith(
    {
      serviceName: "app",
      serviceVersion: "1.0.0",
      environment: "test",
      endpoint: "https://gw.test/_o11y",
      ...(o.memory === true ? {} : { storage }),
      ...options,
    },
    deps,
    o.install ?? false,
  );
  return {
    telemetry,
    env,
    storage,
    transport,
    queue: () => {
      if (queue === undefined) throw new Error("no queue was opened");
      return queue;
    },
    queueOptions,
    transportOptions,
    deliveryOptions,
    network,
    platform,
    sent: (signal = "traces") => transport.requests.filter((r) => r.signal === signal),
    span: (name) => telemetry.tracerProvider.getTracer("t").startSpan(name).end(),
  };
}
