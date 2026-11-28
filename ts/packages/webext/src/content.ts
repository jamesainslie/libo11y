/**
 * WP5 (webext). setupContentScript for content scripts and extension pages.
 */
import {
  createTelemetryWith,
  type Platform,
  type SignalReport,
  setupWith,
  type TelemetryOptions,
} from "@libo11y/core";
import {
  type BrowserExportOptions,
  type DocumentLoadOptions,
  type HttpInstrumentationOptions,
  installXhrInstrumentation,
  recordDocumentLoad,
} from "@libo11y/web";
import {
  activeConsent,
  type ConsentController,
  type ConsentControllerOptions,
  createConsentController,
  createDelivery,
  createMemoryQueue,
  type Delivery,
  type DeliveryOptions,
  installFetchInstrumentation,
  installFlushOnHide,
  type PersistentQueue,
  type QueueOptions,
  type SignalEndpoints,
  setActiveConsent,
  type VisibilitySource,
  type WebPlatformOptions,
  webPlatform,
} from "@libo11y/web/internal";
import { flushInBackground } from "@libo11y/web/portable";
import { diag } from "@opentelemetry/api";
import { type ChromeLike, getChrome } from "./chrome.ts";
import { readStoredConsent, syncConsent } from "./consent-sync.ts";
import { createTracedMessaging } from "./messaging.ts";
import { createMessagingTransport } from "./messaging-transport.ts";
import type { ContentScriptSetupOptions, ContentScriptTelemetry } from "./options.ts";

/**
 * The endpoint every signal of a content script or extension page reports: a marker, not a URL,
 * because the batches leave through the worker.
 */
export const WORKER_ENDPOINT = "libo11y-webext:worker";

const EXTENSION_PROTOCOLS: readonly string[] = [
  "chrome-extension:",
  "moz-extension:",
  "safari-web-extension:",
];

/**
 * What setupContentScriptWith builds on. Internal: the default is the real modules and this
 * context's document, window and location; tests replace any of them.
 */
export interface ContentDeps {
  readonly chrome: ChromeLike | undefined;
  readonly createConsentController: (opts: ConsentControllerOptions) => ConsentController;
  readonly createMemoryQueue: (opts: QueueOptions) => PersistentQueue;
  readonly createDelivery: (opts: DeliveryOptions) => Delivery;
  readonly webPlatform: (opts: WebPlatformOptions) => Platform;
  readonly installFetchInstrumentation: (opts: HttpInstrumentationOptions) => () => void;
  readonly installXhrInstrumentation: (opts: HttpInstrumentationOptions) => () => void;
  readonly recordDocumentLoad: (opts: DocumentLoadOptions) => Promise<void>;
  readonly installFlushOnHide: (
    target: VisibilitySource,
    win: EventTarget | undefined,
    flush: () => Promise<unknown>,
  ) => () => void;
  /** Whose hide flushes. Undefined outside a document. */
  readonly document: VisibilitySource | undefined;
  /** Where pagehide fires. */
  readonly window: EventTarget | undefined;
  /** Tells an extension page (chrome-extension:) from a content script. */
  readonly location: { readonly protocol: string } | undefined;
}

/** The real dependencies, reading document, window and location now. */
export function defaultContentDeps(): ContentDeps {
  const g = globalThis as {
    document?: VisibilitySource;
    location?: { protocol: string };
    addEventListener?: unknown;
  };
  const doc = g.document;
  return {
    chrome: getChrome(),
    createConsentController,
    createMemoryQueue,
    createDelivery,
    webPlatform,
    installFetchInstrumentation,
    installXhrInstrumentation,
    recordDocumentLoad,
    installFlushOnHide,
    document: doc,
    window:
      doc !== undefined && typeof g.addEventListener === "function" ? (globalThis as EventTarget) : undefined,
    location: g.location,
  };
}

/**
 * Builds and installs telemetry whose exporters forward to the worker. In order: the consent
 * controller from readStoredConsent (default "pending") and syncConsent; a memory queue; the
 * messaging transport; a delivery (mode "normal", always online, because messaging the worker
 * needs no network and the worker handles being offline); webPlatform with name "webext" and endpoints
 * set for all three signals to the marker "libo11y-webext:worker" (the batches never leave by
 * HTTP from here); setupWith with console defaulting to false; the instrumentations; flush on hide
 * when there is a document. Records cross to the worker as ExportMessages, and the application's
 * own messages carry context through the handle's sendMessage and onMessage.
 *
 * This context reads no privacy signals; the worker's consent options decide them for the whole
 * extension. A grant here that the worker's respected DNT or GPC signal refuses is undone: the
 * worker stores "denied", and this context revokes, clearing its buffers.
 */
export function setupContentScript(options: ContentScriptSetupOptions = {}): Promise<ContentScriptTelemetry> {
  return setupContentScriptWith(options, defaultContentDeps());
}

async function cleanup(steps: readonly (() => unknown)[]): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      diag.warn("o11y: webext content script shutdown step failed", err);
    }
  }
}

/**
 * setupContentScript over deps. Internal: the seam the unit tests and @libo11y/rum use. With install
 * false it builds the telemetry as web's createTelemetry does: no globals, no instrumentation and
 * no active consent, still flushing on hide (tests that run two contexts in one process).
 */
export async function setupContentScriptWith(
  options: ContentScriptSetupOptions,
  deps: ContentDeps,
  install = true,
): Promise<ContentScriptTelemetry> {
  const chrome = deps.chrome;
  if (chrome === undefined) {
    throw new Error("o11y: setupContentScript needs the extension API (chrome.runtime)");
  }
  const stored = await readStoredConsent(chrome);
  const controller = deps.createConsentController(stored === undefined ? {} : { initial: stored });
  const steps: (() => unknown)[] = [syncConsent(controller, chrome).stop];
  const queue = deps.createMemoryQueue({});
  steps.push(() => queue.close());
  const delivery = deps.createDelivery({
    transport: createMessagingTransport(chrome),
    queue,
    gate: controller,
    mode: () => "normal",
    // Messaging the worker needs no network; the worker queues while the browser is offline.
    isOnline: () => true,
  });
  steps.unshift(() => delivery.shutdown());

  const endpoints: SignalEndpoints = {
    traces: WORKER_ENDPOINT,
    metrics: WORKER_ENDPOINT,
    logs: WORKER_ENDPOINT,
  };
  const exportOptions: BrowserExportOptions = {
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
  };
  let telemetry: Awaited<ReturnType<typeof setupWith>>;
  try {
    const platform = deps.webPlatform({
      name: "webext",
      exportOptions,
      endpoints,
      delivery,
      gate: controller,
      mode: () => "normal",
      ...(options.contextManager === undefined ? {} : { contextManager: options.contextManager }),
    });
    const coreOptions: TelemetryOptions = { ...options, console: options.console ?? false };
    telemetry = install
      ? await setupWith(coreOptions, platform)
      : await createTelemetryWith(coreOptions, platform);
  } catch (err) {
    await cleanup(steps);
    throw err;
  }

  const core = telemetry;
  const doc = deps.document;
  if (doc !== undefined)
    steps.unshift(deps.installFlushOnHide(doc, deps.window, () => flushInBackground(core, "flush on hide")));
  steps.unshift(
    // The queue is emptied first, whatever the flush does, as on a page.
    controller.onRevoke(async () => {
      const cleared = delivery.clear();
      try {
        await core.forceFlush();
      } finally {
        await cleared;
      }
    }),
  );
  const messaging = createTracedMessaging(chrome, core.propagator);
  const uninstalls: (() => void)[] = [];

  // Core's handle extended in place, so identity-keyed lookups such as exemplarStoreOf still work.
  const handle = core as ContentScriptTelemetry;
  Object.defineProperty(handle, "consent", { value: controller.consent, enumerable: true });
  Object.assign(handle, { onMessage: messaging.onMessage, sendMessage: messaging.sendMessage });
  const coreShutdown = core.shutdown.bind(core);
  let shutdownPromise: Promise<SignalReport> | undefined;
  handle.shutdown = (opts) => {
    shutdownPromise ??= (async () => {
      const report = await coreShutdown(opts);
      await cleanup([
        ...uninstalls,
        () => {
          if (activeConsent() === controller.consent) setActiveConsent(undefined);
        },
        ...steps,
      ]);
      return report;
    })();
    return shutdownPromise;
  };

  if (!install) return handle;
  try {
    setActiveConsent(controller.consent);
    const instr = options.instrumentations ?? {};
    const http: HttpInstrumentationOptions = {
      telemetry: handle,
      propagateTo: instr.propagateTo ?? [],
      ignoreUrls: instr.ignoreUrls ?? [],
    };
    if (instr.fetch !== false) uninstalls.push(deps.installFetchInstrumentation(http));
    if (instr.xhr !== false) uninstalls.push(deps.installXhrInstrumentation(http));
    const extensionPage = EXTENSION_PROTOCOLS.includes(deps.location?.protocol ?? "");
    if (instr.documentLoad ?? extensionPage) {
      const abort = new AbortController();
      uninstalls.push(() => abort.abort());
      void deps.recordDocumentLoad({ telemetry: handle, signal: abort.signal });
    }
  } catch (err) {
    await handle.shutdown();
    throw err;
  }
  return handle;
}
