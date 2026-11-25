/**
 * WP5 (webext). setupWorker for a Manifest V3 service worker.
 */
import { type Platform, type SignalReport, setupWith, type TelemetryOptions } from "@libo11y/core";
import type { BrowserExportOptions, HttpInstrumentationOptions } from "@libo11y/web";
import {
  activeConsent,
  type ConsentController,
  type ConsentControllerOptions,
  createConsentController,
  createDelivery,
  createHttpTransport,
  type Delivery,
  type DeliveryOptions,
  type HttpTransportOptions,
  installFetchInstrumentation,
  OTLP_SIGNALS,
  openQueue,
  type PersistentQueue,
  type QueueOptions,
  resolveEndpoints,
  type SignalEndpoints,
  setActiveConsent,
  type Transport,
  type WebPlatformOptions,
  webPlatform,
} from "@libo11y/web/internal";
import { diag } from "@opentelemetry/api";
import { type ChromeLike, getChrome, type RuntimeMessageListener } from "./chrome.ts";
import { CONSENT_STORAGE_KEY, readStoredConsent, syncConsent } from "./consent-sync.ts";
import { createTracedMessaging, sendTracedTabMessage } from "./messaging.ts";
import type { WorkerSetupOptions, WorkerTelemetry } from "./options.ts";
import { type ExportReply, isExportMessage, PROTOCOL_VERSION } from "./protocol.ts";

/** OTEL_* defaults for the worker, under the caller's env: short delays, because the worker can stop at any time. */
export const WORKER_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  OTEL_BSP_SCHEDULE_DELAY: "1000",
  OTEL_BLRP_SCHEDULE_DELAY: "1000",
  OTEL_METRIC_EXPORT_INTERVAL: "15000",
};

/**
 * What setupWorkerWith builds on. Internal: the default is the real modules and getChrome(); tests
 * replace any of them.
 */
export interface WorkerDeps {
  readonly chrome: ChromeLike | undefined;
  readonly createConsentController: (opts: ConsentControllerOptions) => ConsentController;
  readonly openQueue: (opts: QueueOptions) => Promise<PersistentQueue>;
  readonly resolveEndpoints: (opts: BrowserExportOptions, hermetic: boolean) => SignalEndpoints;
  readonly createHttpTransport: (opts: HttpTransportOptions) => Transport;
  readonly createDelivery: (opts: DeliveryOptions) => Delivery;
  readonly webPlatform: (opts: WebPlatformOptions) => Platform;
  readonly installFetchInstrumentation: (opts: HttpInstrumentationOptions) => () => void;
}

/** The real dependencies. */
export function defaultWorkerDeps(): WorkerDeps {
  return {
    chrome: getChrome(),
    createConsentController,
    openQueue,
    resolveEndpoints: (opts, hermetic) => resolveEndpoints(opts, hermetic),
    createHttpTransport,
    createDelivery,
    webPlatform,
    installFetchInstrumentation,
  };
}

/**
 * Builds and installs the worker's telemetry. Call it at the top level of the worker script on
 * every wake. In order: the consent controller with the stored state beating options.consent
 * (readStoredConsent) and syncConsent; openQueue (IndexedDB at the extension origin); the HTTP
 * transport with sendBeacon undefined; a delivery with persistFirst true and mode always "normal";
 * webPlatform with name "webext" and WORKER_ENV_DEFAULTS; setupWith; serviceVersion defaulting to
 * the manifest version. Then: the runtime.onMessage listener for ExportMessages from this
 * extension's own contexts (sender.id === runtime.id), which puts each accepted batch in the queue,
 * replies, and drains; the worker's fetch instrumentation; and a drain of whatever the last wake
 * left. Rejects like setup on a bad configuration.
 *
 * The export listener is registered before the first await, so the message that woke the worker
 * reaches it; batches that arrive before the telemetry is ready are answered once it is. When no
 * state is stored yet, a granted or denied initial state is stored for the content scripts to read.
 * The console sink defaults to off, as on the web.
 */
export function setupWorker(options: WorkerSetupOptions = {}): Promise<WorkerTelemetry> {
  return setupWorkerWith(options, defaultWorkerDeps());
}

/** What the export listener needs once the telemetry is up. */
interface Accepting {
  readonly gate: ConsentController;
  readonly queue: PersistentQueue;
  readonly delivery: Delivery;
}

function refused(reason: string): ExportReply {
  return { libo11y: PROTOCOL_VERSION, type: "export-reply", ok: false, reason };
}

const ACCEPTED: ExportReply = { libo11y: PROTOCOL_VERSION, type: "export-reply", ok: true };

// isExportFrame is true for anything that claims to be an ExportMessage, well-formed or not, so a
// malformed one gets a refusal rather than silence.
function isExportFrame(m: unknown): boolean {
  return (
    typeof m === "object" &&
    m !== null &&
    (m as { libo11y?: unknown }).libo11y === PROTOCOL_VERSION &&
    (m as { type?: unknown }).type === "export"
  );
}

async function accept(message: unknown, target: Accepting | undefined): Promise<ExportReply> {
  if (target === undefined) return refused("the worker's telemetry is not set up");
  if (!isExportMessage(message)) return refused("malformed export message");
  if (!target.gate.recording()) return refused("consent is not granted");
  const entry = await target.queue.put({ signal: message.signal, body: message.body });
  if (entry === undefined) return refused("the queue refused the batch");
  return ACCEPTED;
}

async function cleanup(steps: readonly (() => unknown)[]): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      diag.warn("o11y: webext worker shutdown step failed", err);
    }
  }
}

function queueOptions(options: WorkerSetupOptions): QueueOptions {
  const t = options.transport ?? {};
  return {
    ...(t.databaseName === undefined ? {} : { databaseName: t.databaseName }),
    ...(t.maxQueueBytes === undefined ? {} : { maxBytes: t.maxQueueBytes }),
    ...(t.maxQueueAgeMillis === undefined ? {} : { maxAgeMillis: t.maxQueueAgeMillis }),
  };
}

/** setupWorker over deps. Internal: the seam the unit tests use. */
export async function setupWorkerWith(
  options: WorkerSetupOptions,
  deps: WorkerDeps,
): Promise<WorkerTelemetry> {
  const chrome = deps.chrome;
  if (chrome === undefined) {
    throw new Error("o11y: setupWorker needs the extension API (chrome.runtime) of a service worker");
  }

  // Registered synchronously, before any await, so the event that woke the worker is delivered.
  let settle: (target: Accepting | undefined) => void = () => {};
  const ready = new Promise<Accepting | undefined>((resolve) => {
    settle = resolve;
  });
  const onExport: RuntimeMessageListener = (message, sender, sendResponse) => {
    if (!isExportFrame(message) || sender.id !== chrome.runtime.id) return undefined;
    void ready.then(async (target) => {
      const reply = await accept(message, target);
      sendResponse(reply);
      if (reply.ok) void target?.delivery.drain();
    });
    return true;
  };
  const acceptForwarded = options.acceptForwarded !== false;
  if (acceptForwarded) chrome.runtime.onMessage.addListener(onExport);
  const removeExportListener = (): void => {
    if (acceptForwarded) chrome.runtime.onMessage.removeListener(onExport);
  };

  const steps: (() => unknown)[] = [];
  let built: {
    controller: ConsentController;
    queue: PersistentQueue;
    delivery: Delivery;
    endpoints: SignalEndpoints;
  };
  let core: Awaited<ReturnType<typeof setupWith>>;
  try {
    const stored = await readStoredConsent(chrome);
    const initial = stored ?? options.consent?.initial;
    const controller = deps.createConsentController({
      ...options.consent,
      ...(initial === undefined ? {} : { initial }),
    });
    const initialState = controller.consent.state();
    if (stored === undefined && initialState !== "pending" && chrome.storage !== undefined) {
      chrome.storage.local.set({ [CONSENT_STORAGE_KEY]: initialState }).catch((err: unknown) => {
        diag.warn("o11y: storing the initial consent state", err);
      });
    }
    steps.push(syncConsent(controller, chrome));

    const queue = await deps.openQueue(queueOptions(options));
    steps.push(() => queue.close());
    const endpoints = deps.resolveEndpoints(options, options.hermetic === true);
    const t = options.transport ?? {};
    const transport = deps.createHttpTransport({
      endpoints,
      sendBeacon: undefined,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(t.compression === undefined ? {} : { compression: t.compression }),
      ...(t.timeoutMillis === undefined ? {} : { timeoutMillis: t.timeoutMillis }),
    });
    const delivery = deps.createDelivery({
      transport,
      queue,
      gate: controller,
      persistFirst: true,
      mode: () => "normal",
      ...(t.initialBackoffMillis === undefined ? {} : { initialBackoffMillis: t.initialBackoffMillis }),
      ...(t.maxBackoffMillis === undefined ? {} : { maxBackoffMillis: t.maxBackoffMillis }),
    });
    steps.unshift(() => delivery.shutdown());
    const platform = deps.webPlatform({
      name: "webext",
      exportOptions: options,
      endpoints,
      delivery,
      gate: controller,
      mode: () => "normal",
      envDefaults: WORKER_ENV_DEFAULTS,
      ...(options.contextManager === undefined ? {} : { contextManager: options.contextManager }),
    });
    const coreOptions: TelemetryOptions = {
      ...options,
      console: options.console ?? false,
      serviceVersion: options.serviceVersion ?? chrome.runtime.getManifest().version,
    };
    core = await setupWith(coreOptions, platform);
    built = { controller, queue, delivery, endpoints };
  } catch (err) {
    removeExportListener();
    settle(undefined);
    await cleanup(steps);
    throw err;
  }

  const { controller, queue, delivery, endpoints } = built;
  const telemetry = core;
  const unregisterRevoke = controller.onRevoke(async () => {
    await telemetry.forceFlush();
    await delivery.clear();
  });
  const messaging = createTracedMessaging(chrome, telemetry.propagator);
  const uninstalls: (() => void)[] = [];

  // Core's handle extended in place, so identity-keyed lookups such as exemplarStoreOf still work.
  const handle = telemetry as WorkerTelemetry;
  Object.defineProperty(handle, "consent", { value: controller.consent, enumerable: true });
  Object.assign(handle, {
    onMessage: messaging.onMessage,
    sendMessage: messaging.sendMessage,
    sendTabMessage: <R>(tabId: number, payload: unknown): Promise<R> =>
      sendTracedTabMessage<R>(chrome, telemetry.propagator, tabId, payload),
  });
  const coreShutdown = telemetry.shutdown.bind(telemetry);
  let shutdownPromise: Promise<SignalReport> | undefined;
  handle.shutdown = (opts) => {
    shutdownPromise ??= (async () => {
      removeExportListener();
      const report = await coreShutdown(opts);
      await cleanup([
        ...uninstalls,
        unregisterRevoke,
        () => {
          if (activeConsent() === controller.consent) setActiveConsent(undefined);
        },
        ...steps,
      ]);
      return report;
    })();
    return shutdownPromise;
  };

  try {
    setActiveConsent(controller.consent);
    if (options.fetch !== false) {
      const f = typeof options.fetch === "object" ? options.fetch : {};
      uninstalls.push(
        deps.installFetchInstrumentation({
          telemetry: handle,
          propagateTo: f.propagateTo ?? [],
          ignoreUrls: [
            ...(f.ignoreUrls ?? []),
            ...OTLP_SIGNALS.flatMap((s) => (endpoints[s] === undefined ? [] : [endpoints[s]])),
          ],
        }),
      );
    }
  } catch (err) {
    settle(undefined);
    await handle.shutdown();
    throw err;
  }

  settle({ gate: controller, queue, delivery });
  void delivery.drain();
  return handle;
}
