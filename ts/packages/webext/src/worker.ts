/**
 * setupWorker for a Manifest V3 service worker.
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
  shutdownWithin,
  type Transport,
  type WebPlatformOptions,
  webPlatform,
} from "@libo11y/web/internal";
import { diag } from "@opentelemetry/api";
import { type ChromeLike, getChrome, type MessageSenderLike, type RuntimeMessageListener } from "./chrome.ts";
import { CONSENT_STORAGE_KEY, type ConsentSync, readStoredConsent, syncConsent } from "./consent-sync.ts";
import { createTracedMessaging, sendTracedTabMessage, tracedListener } from "./messaging.ts";
import type { TracedMessageListener, WorkerSetupOptions, WorkerTelemetry } from "./options.ts";
import { type ExportReply, isExportMessage, isTracedMessage, PROTOCOL_VERSION } from "./protocol.ts";

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
 * (readStoredConsent) and syncConsent; openQueue (IndexedDB at the extension origin), releasing
 * every lease an earlier wake left (it is the queue's only user, so none of those sends is still in
 * flight); the HTTP
 * transport with sendBeacon undefined; a delivery with persistFirst true, mode always "normal" and a
 * lease of three times transport.timeoutMillis when that is longer than the default;
 * webPlatform with name "webext" and WORKER_ENV_DEFAULTS, with the manifest version as a detected
 * service.version (below OTEL_RESOURCE_ATTRIBUTES and the serviceVersion option); setupWith. A wake
 * to a denied consent clears the queue before the delivery is built. Then: the runtime.onMessage
 * listener for ExportMessages from this extension's own contexts (sender.id === runtime.id),
 * which puts each accepted batch in the queue, replies, and drains; the worker's fetch instrumentation; and a drain of whatever the last wake
 * left. Rejects like setup on a bad configuration.
 *
 * The export listener is registered before the first await, so the message that woke the worker
 * reaches it; batches that arrive before the telemetry is ready are answered once it is. Traced
 * messages that arrive before the application can add its listener are held, and replayed one task
 * after this resolves to the listeners added through the handle's onMessage by then, so add them
 * in the first callback on the returned promise. A service worker cannot use a top-level await, so
 * the pattern is:
 *
 * ```ts
 * setupWorker(options).then((t) => t.onMessage(handle));
 * ```
 *
 * Each batch re-reads the stored consent before it is accepted, so a grant
 * or revoke in another context counts before its storage.onChanged arrives. When no state is
 * stored yet, a granted or denied initial state is stored for the content scripts to read. The
 * worker's consent options decide the privacy signals for the whole extension: a stored grant
 * that a respected DNT or GPC signal refuses, from a content script or an earlier wake, is
 * replaced in storage by "denied", so every context denies (syncConsent). The
 * console sink defaults to off, as on the web.
 */
export function setupWorker(options: WorkerSetupOptions = {}): Promise<WorkerTelemetry> {
  return setupWorkerWith(options, defaultWorkerDeps());
}

/**
 * The delivery lease for a transport timeout: three times it, never less than the delivery's
 * 30-second default. As leaseForTimeout in @libo11y/web, whose internal entry point does not
 * export it.
 */
function leaseForTimeout(timeoutMillis: number): number {
  return Math.max(30_000, 3 * timeoutMillis);
}

/**
 * platform with the manifest version as a detected service.version, so OTEL_RESOURCE_ATTRIBUTES and
 * the serviceVersion option both beat it, as core merges the layers.
 */
function withManifestVersion(platform: Platform, version: string): Platform {
  if (version.trim() === "") return platform;
  return {
    ...platform,
    async detectResource(hermetic) {
      const layers = await platform.detectResource(hermetic);
      return { ...layers, detected: { ...layers.detected, "service.version": version } };
    },
  };
}

/** What the export listener needs once the telemetry is up. */
interface Accepting {
  readonly gate: ConsentController;
  readonly queue: PersistentQueue;
  readonly delivery: Delivery;
  /** Applies the stored consent now, so a grant or revoke elsewhere counts before onChanged. */
  readonly refreshConsent: () => Promise<void>;
}

function refused(reason: string): ExportReply {
  return { libo11y: PROTOCOL_VERSION, type: "export-reply", ok: false, reason };
}

const ACCEPTED: ExportReply = { libo11y: PROTOCOL_VERSION, type: "export-reply", ok: true };
const CONSENT_CLOSED = "consent is not granted";

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
  await target.refreshConsent();
  if (!target.gate.recording()) return refused(CONSENT_CLOSED);
  const entry = await target.queue.put({ signal: message.signal, body: message.body });
  if (entry === undefined) return refused("the queue refused the batch");
  if (!target.gate.recording()) {
    // Revoked while the batch was being stored: the revoke's clear may have run before the put.
    await target.queue.remove([entry.id]);
    return refused(CONSENT_CLOSED);
  }
  return ACCEPTED;
}

// answer accepts message, replies, and drains on acceptance. It never rejects: a failure is a
// refusal, and a reply that cannot be sent (the sender went away) still leaves the batch drained.
async function answer(
  message: unknown,
  target: Accepting | undefined,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  let reply: ExportReply;
  try {
    reply = await accept(message, target);
  } catch (err) {
    diag.warn("o11y: webext worker failed to accept a batch", err);
    reply = refused(
      `the worker failed to store the batch: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    sendResponse(reply);
  } catch (err) {
    diag.debug("o11y: webext worker could not answer an export", err);
  }
  if (reply.ok) void target?.delivery.drain();
}

/** How many early traced messages the worker holds at most; more are left to other contexts. */
const MAX_HELD_TRACED = 100;

/** A traced message that arrived before the application could add its traced listeners. */
interface HeldTraced {
  readonly message: unknown;
  readonly sender: MessageSenderLike;
  readonly sendResponse: (response?: unknown) => void;
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
    void ready.then((target) => answer(message, target, sendResponse));
    return true;
  };
  const acceptForwarded = options.acceptForwarded !== false;
  if (acceptForwarded) chrome.runtime.onMessage.addListener(onExport);
  const removeExportListener = (): void => {
    if (acceptForwarded) chrome.runtime.onMessage.removeListener(onExport);
  };

  // The application can add its traced listeners only once this resolves, after the browser has
  // dispatched the message that woke the worker. So traced messages that no traced listener can
  // take yet are held, and replayed one task after setup resolves to the listeners added by then.
  // Held messages nobody takes are left unanswered, for another context's listener to answer.
  const tracedListeners: RuntimeMessageListener[] = [];
  const held: HeldTraced[] = [];
  let holding = true;
  const onEarlyTraced: RuntimeMessageListener = (message, sender, sendResponse) => {
    if (!holding || tracedListeners.length > 0 || held.length >= MAX_HELD_TRACED) return undefined;
    if (!isTracedMessage(message) || sender.id !== chrome.runtime.id) return undefined;
    held.push({ message, sender, sendResponse });
    return true;
  };
  chrome.runtime.onMessage.addListener(onEarlyTraced);
  const releaseHeld = (): void => {
    if (!holding) return;
    holding = false;
    chrome.runtime.onMessage.removeListener(onEarlyTraced);
    for (const h of held.splice(0)) {
      let answered = false;
      const once = (response?: unknown): void => {
        if (answered) return;
        answered = true;
        try {
          h.sendResponse(response);
        } catch (err) {
          diag.debug("o11y: webext worker could not answer a held traced message", err);
        }
      };
      for (const listener of [...tracedListeners]) {
        try {
          listener(h.message, h.sender, once);
        } catch (err) {
          diag.warn("o11y: webext traced listener failed on a held message", err);
        }
      }
    }
  };

  const steps: (() => unknown)[] = [];
  // Kept apart from steps: a working handle shuts the delivery down under its deadline itself.
  let stopDelivery: (() => unknown) | undefined;
  let built: {
    controller: ConsentController;
    queue: PersistentQueue;
    delivery: Delivery;
    endpoints: SignalEndpoints;
  };
  let core: Awaited<ReturnType<typeof setupWith>>;
  let sync: ConsentSync | undefined;
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
    sync = syncConsent(controller, chrome);
    steps.push(sync.stop);

    const queue = await deps.openQueue(queueOptions(options));
    steps.push(() => queue.close());
    // The worker is the only context that uses its queue, so a lease held now is one the browser
    // cut off when it stopped an earlier wake mid-send. Released before the delivery exists, so no
    // send of this wake is in flight yet, and the first drain sends those entries at once.
    await queue.releaseLeases();
    // A wake to a denied state (another context revoked while the worker was stopped, or a
    // respected privacy signal refuses the stored grant) runs no revoke hook in this wake, so the
    // earlier wake's batches are cleared here, before the delivery exists. A pending wake keeps them.
    if (controller.consent.state() === "denied") {
      try {
        await queue.clear();
      } catch (err) {
        diag.warn("o11y: clearing the queue of a denied wake failed", err);
      }
    }
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
      // A lease shorter than a send could let the next drain claim the entry mid-send and resend it.
      ...(t.timeoutMillis === undefined ? {} : { leaseMillis: leaseForTimeout(t.timeoutMillis) }),
    });
    stopDelivery = () => delivery.shutdown();
    const web = deps.webPlatform({
      name: "webext",
      exportOptions: options,
      endpoints,
      delivery,
      gate: controller,
      mode: () => "normal",
      envDefaults: WORKER_ENV_DEFAULTS,
      ...(options.contextManager === undefined ? {} : { contextManager: options.contextManager }),
    });
    const platform = withManifestVersion(web, chrome.runtime.getManifest().version);
    const coreOptions: TelemetryOptions = { ...options, console: options.console ?? false };
    core = await setupWith(coreOptions, platform);
    built = { controller, queue, delivery, endpoints };
  } catch (err) {
    removeExportListener();
    releaseHeld();
    settle(undefined);
    await cleanup([...(stopDelivery === undefined ? [] : [stopDelivery]), ...steps]);
    throw err;
  }

  const { controller, queue, delivery, endpoints } = built;
  const telemetry = core;
  // The queue is emptied first, whatever the flush does: a flush waits for exports in flight, up to
  // its deadline, and a worker stopped in that time would otherwise keep the queue for a later grant.
  const unregisterRevoke = controller.onRevoke(async () => {
    const cleared = delivery.clear();
    try {
      await telemetry.forceFlush();
    } finally {
      await cleared;
    }
  });
  const messaging = createTracedMessaging(chrome, telemetry.propagator);
  const uninstalls: (() => void)[] = [];

  // Core's handle extended in place, so identity-keyed lookups such as exemplarStoreOf still work.
  const handle = telemetry as WorkerTelemetry;
  Object.defineProperty(handle, "consent", { value: controller.consent, enumerable: true });
  Object.assign(handle, {
    onMessage: (listener: TracedMessageListener): (() => void) => {
      const onRuntimeMessage = tracedListener(telemetry.propagator, listener);
      tracedListeners.push(onRuntimeMessage);
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
      return () => {
        const i = tracedListeners.indexOf(onRuntimeMessage);
        if (i >= 0) tracedListeners.splice(i, 1);
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      };
    },
    sendMessage: messaging.sendMessage,
    sendTabMessage: <R>(tabId: number, payload: unknown): Promise<R> =>
      sendTracedTabMessage<R>(chrome, telemetry.propagator, tabId, payload),
  });
  // Shutdown removes every traced listener the handle added.
  const removeTracedListeners = (): void => {
    for (const listener of tracedListeners.splice(0)) chrome.runtime.onMessage.removeListener(listener);
  };
  const coreShutdown = telemetry.shutdown.bind(telemetry);
  let shutdownPromise: Promise<SignalReport> | undefined;
  handle.shutdown = (opts) => {
    shutdownPromise ??= (async () => {
      removeExportListener();
      releaseHeld();
      // One deadline: core's providers, then the delivery's drain in what is left of it.
      const report = await shutdownWithin(coreShutdown, delivery, opts);
      await cleanup([
        ...uninstalls,
        removeTracedListeners,
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

  settle({ gate: controller, queue, delivery, refreshConsent: sync?.refresh ?? (async () => {}) });
  setTimeout(releaseHeld, 0);
  void delivery.drain();
  return handle;
}
