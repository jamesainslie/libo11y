/**
 * setup and createTelemetry for browsers.
 */
import {
  createTelemetryWith,
  type Platform,
  type SignalReport,
  setupWith,
  type Telemetry,
  type TelemetryOptions,
} from "@libo11y/core";
import { diag } from "@opentelemetry/api";
import { flushInBackground } from "./background-flush.ts";
import { activeConsent, setActiveConsent } from "./consent/active.ts";
import { createConsentController } from "./consent/controller.ts";
import type { ConsentController, ConsentControllerOptions } from "./contracts/consent.ts";
import { OTLP_SIGNALS } from "./contracts/otlp.ts";
import type { PersistentQueue, QueueOptions } from "./contracts/queue.ts";
import type { Delivery, DeliveryOptions, SendMode, Transport } from "./contracts/transport.ts";
import { recordDocumentLoad } from "./instrumentation/document-load.ts";
import { installFetchInstrumentation } from "./instrumentation/fetch.ts";
import { installXhrInstrumentation } from "./instrumentation/xhr.ts";
import { installFlushOnHide, type VisibilitySource } from "./lifecycle.ts";
import type {
  BrowserExportOptions,
  DocumentLoadOptions,
  HttpInstrumentationOptions,
  WebSetupOptions,
  WebTelemetry,
} from "./options.ts";
import { type WebPlatformOptions, webPlatformWith } from "./platform.ts";
import { openQueue } from "./queue/open.ts";
import { shutdownWithin } from "./shutdown.ts";
import { createDelivery, leaseForTimeout } from "./transport/delivery.ts";
import { resolveEndpoints, type SignalEndpoints } from "./transport/endpoints.ts";
import { createExporterSet } from "./transport/exporters.ts";
import { createHttpTransport, type HttpTransportOptions } from "./transport/http.ts";

/**
 * What setupWithDeps builds on. Internal: the default is the real modules and the page's document
 * and window; tests replace any of them.
 */
export interface SetupDeps {
  readonly createConsentController: (opts: ConsentControllerOptions) => ConsentController;
  readonly openQueue: (opts: QueueOptions) => Promise<PersistentQueue>;
  readonly resolveEndpoints: (opts: BrowserExportOptions, hermetic: boolean) => SignalEndpoints;
  readonly createHttpTransport: (opts: HttpTransportOptions) => Transport;
  readonly createDelivery: (opts: DeliveryOptions) => Delivery;
  readonly createExporterSet: typeof createExporterSet;
  readonly installFetchInstrumentation: (opts: HttpInstrumentationOptions) => () => void;
  readonly installXhrInstrumentation: (opts: HttpInstrumentationOptions) => () => void;
  readonly recordDocumentLoad: (opts: DocumentLoadOptions) => Promise<void>;
  /** Whose visibility decides the send mode and the flush on hide. Undefined outside a page. */
  readonly document: VisibilitySource | undefined;
  /** Where pagehide and pageshow fire. */
  readonly window: EventTarget | undefined;
  /** Observes the platform before core builds on it. Tests only. */
  readonly onPlatform?: (platform: Platform, opts: WebPlatformOptions) => void;
}

/** The real dependencies, reading document and window now. */
export function defaultSetupDeps(): SetupDeps {
  const g = globalThis as { document?: VisibilitySource; addEventListener?: unknown };
  const doc = g.document;
  return {
    createConsentController,
    openQueue,
    resolveEndpoints,
    createHttpTransport,
    createDelivery,
    createExporterSet,
    installFetchInstrumentation,
    installXhrInstrumentation,
    recordDocumentLoad,
    document: doc,
    window:
      doc !== undefined && typeof g.addEventListener === "function" ? (globalThis as EventTarget) : undefined,
  };
}

/**
 * Builds browser telemetry and installs it globally, as the server's setup does, then: records the
 * consent as the active consent, patches fetch and XMLHttpRequest and records the documentLoad span
 * as options.instrumentations says, and flushes on hide. In order: the consent controller, the
 * queue (openQueue, unless transport.offlineQueue is false), the endpoints, the HTTP transport, the
 * delivery (mode from document visibility, and a lease of three times transport.timeoutMillis when
 * that is longer than the default lease), webPlatform, setupWith with console defaulting to
 * false, then the handle. consent.onRevoke clears the delivery and, without waiting for that,
 * flushes every provider into the closed gate. After setup the queue is drained once.
 *
 * A page that starts denied clears the queue before the delivery is built, so a batch an earlier
 * page load queued is never sent after a later grant.
 *
 * The handle is core's Telemetry extended in place with consent (so exemplarStoreOf still finds
 * it). Its shutdown shuts the providers down, then the delivery in what is left of the same
 * deadline (shutdownWithin), then removes the instrumentation and listeners, clears the active
 * consent and closes the queue.
 */
export function setup(options: WebSetupOptions = {}): Promise<WebTelemetry> {
  return setupWithDeps(options, defaultSetupDeps(), true);
}

/**
 * As setup, without any global: no providers, propagator or context manager installed, no
 * instrumentation, no canary, no active consent. It still flushes on hide and drains the queue.
 */
export function createTelemetry(options: WebSetupOptions = {}): Promise<WebTelemetry> {
  return setupWithDeps(options, defaultSetupDeps(), false);
}

function queueOptions(options: WebSetupOptions): QueueOptions {
  const t = options.transport ?? {};
  return {
    ...(t.databaseName === undefined ? {} : { databaseName: t.databaseName }),
    ...(t.maxQueueBytes === undefined ? {} : { maxBytes: t.maxQueueBytes }),
    ...(t.maxQueueAgeMillis === undefined ? {} : { maxAgeMillis: t.maxQueueAgeMillis }),
  };
}

function transportOptions(options: WebSetupOptions, endpoints: SignalEndpoints): HttpTransportOptions {
  const t = options.transport ?? {};
  return {
    endpoints,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(t.compression === undefined ? {} : { compression: t.compression }),
    ...(t.timeoutMillis === undefined ? {} : { timeoutMillis: t.timeoutMillis }),
  };
}

/** Runs each cleanup step, reporting a failure through diag and going on. */
async function cleanup(steps: readonly (() => unknown)[]): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      diag.warn("o11y: web shutdown step failed", err);
    }
  }
}

/**
 * setup (install true) or createTelemetry (install false) over deps. Internal: the seam the unit
 * tests use to replace the transport, queue, consent and instrumentation.
 */
export async function setupWithDeps(
  options: WebSetupOptions,
  deps: SetupDeps,
  install: boolean,
): Promise<WebTelemetry> {
  const controller = deps.createConsentController(options.consent ?? {});
  const queue =
    options.transport?.offlineQueue === false ? undefined : await deps.openQueue(queueOptions(options));
  // A page that starts denied (consent.initial, or a respected privacy signal) refused what an
  // earlier page load queued, and no revoke in this load will clear it: clear it before any
  // delivery exists, so a later grant cannot send it. A pending start keeps it.
  if (queue !== undefined && controller.consent.state() === "denied") {
    try {
      await queue.clear();
    } catch (err) {
      diag.warn("o11y: clearing the queue of a denied page failed", err);
    }
  }
  const listeners: (() => void)[] = [];
  let delivery: Delivery | undefined;
  let endpoints: SignalEndpoints;
  let telemetry: Telemetry;
  let built: Telemetry | undefined;
  try {
    endpoints = deps.resolveEndpoints(options, options.hermetic === true);
    const transport = deps.createHttpTransport(transportOptions(options, endpoints));

    // The send mode follows visibility (decision 7). pagehide also counts as hidden until
    // pageshow, for browsers that fire it while the document still reports visible.
    const doc = deps.document;
    const win = deps.window;
    let unloading = false;
    const mode = (): SendMode => (unloading || doc?.visibilityState === "hidden" ? "unload" : "normal");
    if (win !== undefined) {
      const onHide = (): void => {
        unloading = true;
      };
      const onShow = (): void => {
        unloading = false;
      };
      win.addEventListener("pagehide", onHide);
      win.addEventListener("pageshow", onShow);
      listeners.push(() => {
        win.removeEventListener("pagehide", onHide);
        win.removeEventListener("pageshow", onShow);
      });
    }

    const t = options.transport ?? {};
    delivery = deps.createDelivery({
      transport,
      ...(queue === undefined ? {} : { queue }),
      gate: controller,
      mode,
      ...(t.initialBackoffMillis === undefined ? {} : { initialBackoffMillis: t.initialBackoffMillis }),
      ...(t.maxBackoffMillis === undefined ? {} : { maxBackoffMillis: t.maxBackoffMillis }),
      // A lease shorter than a send could let another tab claim the entry mid-send and send it twice.
      ...(t.timeoutMillis === undefined ? {} : { leaseMillis: leaseForTimeout(t.timeoutMillis) }),
    });

    const platformOptions: WebPlatformOptions = {
      exportOptions: options,
      endpoints,
      delivery,
      gate: controller,
      mode,
      ...(options.contextManager === undefined ? {} : { contextManager: options.contextManager }),
    };
    const platform = webPlatformWith(platformOptions, { createExporterSet: deps.createExporterSet });
    deps.onPlatform?.(platform, platformOptions);

    const coreOptions: TelemetryOptions = { ...options, console: options.console ?? false };
    telemetry = install
      ? await setupWith(coreOptions, platform)
      : await createTelemetryWith(coreOptions, platform);
    built = telemetry;

    if (doc !== undefined)
      listeners.push(installFlushOnHide(doc, win, () => flushInBackground(telemetry, "flush on hide")));
  } catch (err) {
    const d = delivery;
    const t = built;
    // Core first, so a failure after setupWith also releases its globals and ALREADY_SETUP guard.
    await cleanup([() => t?.shutdown(), ...listeners, () => d?.shutdown(), () => queue?.close()]);
    throw err;
  }

  const activeDelivery = delivery;
  // Revocation: the gate is already closed. The persistent queue is emptied first, whatever the
  // flush does: a flush waits for exports in flight, up to its deadline, and a page closed in that
  // time would otherwise keep the queue for a later grant to send. The flush then drains the SDK
  // buffers into the closed gate, which drops them.
  const unregisterRevoke = controller.onRevoke(async () => {
    const cleared = activeDelivery.clear();
    try {
      await telemetry.forceFlush();
    } finally {
      await cleared;
    }
  });
  const uninstalls: (() => void)[] = [];

  // Core's handle extended in place, so identity-keyed lookups such as exemplarStoreOf still work.
  const handle = telemetry as Telemetry & { readonly consent: WebTelemetry["consent"] };
  Object.defineProperty(handle, "consent", { value: controller.consent, enumerable: true });
  const coreShutdown = telemetry.shutdown.bind(telemetry);
  let shutdownPromise: Promise<SignalReport> | undefined;
  handle.shutdown = (opts) => {
    shutdownPromise ??= (async () => {
      // One deadline: core's providers, then the delivery's drain in what is left of it.
      const report = await shutdownWithin(coreShutdown, activeDelivery, opts);
      await cleanup([
        ...uninstalls,
        ...listeners,
        unregisterRevoke,
        () => {
          if (install && activeConsent() === controller.consent) setActiveConsent(undefined);
        },
        () => queue?.close(),
      ]);
      return report;
    })();
    return shutdownPromise;
  };

  if (install) {
    try {
      setActiveConsent(controller.consent);
      const instr = options.instrumentations ?? {};
      const http: HttpInstrumentationOptions = {
        telemetry: handle,
        propagateTo: instr.propagateTo ?? [],
        ignoreUrls: [
          ...(instr.ignoreUrls ?? []),
          ...OTLP_SIGNALS.flatMap((s) => (endpoints[s] === undefined ? [] : [endpoints[s]])),
        ],
      };
      if (instr.fetch !== false) uninstalls.push(deps.installFetchInstrumentation(http));
      if (instr.xhr !== false) uninstalls.push(deps.installXhrInstrumentation(http));
      if (instr.documentLoad !== false) {
        const abort = new AbortController();
        uninstalls.push(() => abort.abort());
        deps
          .recordDocumentLoad({ telemetry: handle, signal: abort.signal })
          .catch((err: unknown) => diag.warn("o11y: documentLoad failed", err));
      }
    } catch (err) {
      await handle.shutdown();
      throw err;
    }
  }

  void activeDelivery.drain();
  return handle;
}
