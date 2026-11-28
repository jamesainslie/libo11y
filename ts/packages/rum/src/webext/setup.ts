/**
 * RUM in Manifest V3 extensions (decision P20). setupRumExtension runs in extension pages (popups,
 * options pages, side panels) and content scripts; setupRumWorker runs in the service worker.
 *
 * Both contexts of setupRumExtension bind through @libo11y/webext's content script setup, so their
 * records go to the worker by runtime messaging and the worker sends them. Their platform is
 * webext, and they share one session through chrome.storage.session (chromeSessionStore), which a
 * content script reaches once the worker called allowRumSessionInContentScripts (setupRumWorker
 * does). Remote configuration is cached in chrome.storage.local, never in a page's localStorage,
 * and needs an absolute URL, because an extension context has no gateway origin of its own.
 *
 * An extension page behaves as setupRum does, with its retention buffer in IndexedDB at the
 * extension's origin. A content script shares the host page's document, so it records only what is
 * the extension's own:
 * - one view, named content.viewName or "content-script", never named from the URL, starting when
 *   RUM starts and on screen at once. Its span carries the host page's url.domain and no other URL;
 * - actions only on events whose composed path holds content.uiRoot, and none without it;
 * - errors only from the extension's own scripts (errorSourceUrl starts with getURL(""));
 * - no vitals(), resources() or long animation frames, which would measure the host page, and no
 *   documentLoad span: each is refused with O11yError INVALID_OPTION;
 * - a retention buffer in memory, because its IndexedDB is the host page's.
 */
import { O11yError } from "@libo11y/core";
import { browserEnv, createExporterSet, createMemoryQueue } from "@libo11y/web/internal";
import type {
  ContentScriptSetupOptions,
  ContentScriptTelemetry,
  WorkerSetupOptions,
  WorkerTelemetry,
} from "@libo11y/webext";
import {
  type ContentDeps,
  defaultContentDeps,
  defaultWorkerDeps,
  setupContentScriptWith,
  setupWorkerWith,
  type WorkerDeps,
} from "@libo11y/webext/internal";
import { diag } from "@opentelemetry/api";
import type { WebRumBind } from "../bind.ts";
import type { CollectorName } from "../contracts/runtime.ts";
import type { Rum, RumOptions } from "../options.ts";
import { defaultRumDeps, type RumDeps, setupRumWith } from "../setup.ts";
import { gatewayTransportOptions } from "../wire.ts";
import { getRumChrome, type RumChromeLike } from "./chrome.ts";
import { type ConfigStorage, chromeConfigStorage } from "./config-storage.ts";
import { contentScope } from "./scope.ts";
import { allowRumSessionInContentScripts, chromeSessionStore } from "./session-store.ts";

/** The name of a content script's view when content.viewName does not give one. */
export const CONTENT_VIEW_NAME = "content-script";

/** Collectors that would measure the host page, refused in a content script. */
const HOST_PAGE_COLLECTORS: ReadonlySet<CollectorName> = new Set([
  "vitals",
  "resources",
  "long_animation_frames",
]);

/** Options for setupRumExtension: the content script setup options of `@libo11y/webext` and RUM's own. */
export interface RumExtensionOptions extends ContentScriptSetupOptions {
  /** "page" for popups, options pages and side panels; "content" for content scripts. */
  readonly context: "page" | "content";
  /**
   * RUM's options. Remote configuration needs an absolute URL here. In a content script viewName is
   * replaced by the fixed view name, and vitals(), resources() and long animation frames are refused.
   */
  readonly rum?: RumOptions;
  /** Content scripts only. */
  readonly content?: {
    /** The extension's own UI in the page, such as its shadow host. Actions are recorded only inside it; without it, none. */
    readonly uiRoot?: Node;
    /** The name of the content script's one view. Default "content-script". */
    readonly viewName?: string;
  };
}

/** An extension page's or content script's telemetry with RUM. Its records go to the worker. */
export interface RumExtensionTelemetry extends ContentScriptTelemetry {
  readonly rum: Rum;
}

/** What setupRumExtensionWith builds on. Internal: tests replace any of it. */
export interface RumExtensionDeps {
  readonly chrome: RumChromeLike | undefined;
  readonly content: ContentDeps;
  /** RUM's dependencies. The platform, binding, session store and cache storage are replaced, and in a content script the retention queue. */
  readonly rum: RumDeps;
  /** Install the telemetry globally. Default true. */
  readonly install?: boolean;
}

/** The real dependencies of this context. */
export function defaultRumExtensionDeps(): RumExtensionDeps {
  return { chrome: getRumChrome(), content: defaultContentDeps(), rum: defaultRumDeps() };
}

/** The binding of extension contexts: @libo11y/webext's setupContentScriptWith with RUM's wrappers. */
export function contentBinding(content: ContentDeps, install: boolean): WebRumBind {
  return (options, w) =>
    setupContentScriptWith(
      options,
      {
        ...content,
        createConsentController: (o) => w.consentController(content.createConsentController(o)),
        webPlatform: (po) => {
          w.platform(po, browserEnv(options, po.endpoints));
          const platform = content.webPlatform(po);
          return {
            ...platform,
            // Logs are routed by session; app metrics export with delta temporality for the gateway.
            buildExporters: (req) =>
              w.exporterSet(
                createExporterSet(req, po.delivery, po.endpoints, {
                  ...(po.mode === undefined ? {} : { mode: po.mode }),
                  metricTemporality: "delta",
                }),
              ),
          };
        },
        installFetchInstrumentation: (o) =>
          content.installFetchInstrumentation({ ...o, onStart: w.onRequestStart }),
        installXhrInstrumentation: (o) =>
          content.installXhrInstrumentation({ ...o, onStart: w.onRequestStart }),
      },
      install,
    );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function absolute(url: string): boolean {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Builds telemetry with RUM for an extension page or content script and installs it globally. */
export function setupRumExtension(options: RumExtensionOptions): Promise<RumExtensionTelemetry> {
  return setupRumExtensionWith(options, defaultRumExtensionDeps());
}

/** setupRumExtension over deps. Internal: the seam the unit tests use. */
export async function setupRumExtensionWith(
  options: RumExtensionOptions,
  deps: RumExtensionDeps,
): Promise<RumExtensionTelemetry> {
  const { context, rum, content, ...base } = options;
  const chrome = deps.chrome;
  if (chrome === undefined) {
    throw new Error("o11y: setupRumExtension needs the extension API (chrome.runtime)");
  }
  const inContent = context === "content";
  if (inContent) {
    for (const c of rum?.collectors ?? []) {
      if (HOST_PAGE_COLLECTORS.has(c.name)) {
        throw new O11yError(
          "INVALID_OPTION",
          `rum: a content script cannot run ${c.name}, which would measure the host page`,
        );
      }
    }
    if (base.instrumentations?.documentLoad === true) {
      throw new O11yError(
        "INVALID_OPTION",
        "rum: a content script records no documentLoad, the host page's load",
      );
    }
  }
  const configAt = rum?.remoteConfig?.url;
  if (rum?.remoteConfig !== undefined && (configAt === undefined || !absolute(configAt))) {
    throw new O11yError("INVALID_OPTION", "rum.remoteConfig needs an absolute http(s) url in an extension");
  }

  let cache: (ConfigStorage & { close(): void }) | undefined;
  let shutDown = false;
  const extensionBase = chrome.runtime.getURL?.("") ?? `chrome-extension://${chrome.runtime.id}/`;
  const rumDeps: RumDeps = {
    ...deps.rum,
    platform: "webext",
    bind: contentBinding(deps.content, deps.install !== false),
    sessionStore: () => chromeSessionStore(chrome),
    storage: async () => {
      const opened = cache ?? (await chromeConfigStorage(chrome));
      // A cache that finished loading after shutdown stops listening at once.
      if (shutDown) opened?.close();
      else cache = opened;
      return opened;
    },
    ...(inContent
      ? {
          openRetentionQueue: async (o) => createMemoryQueue(o),
          prerendered: () => false,
          scope: contentScope({
            base: extensionBase,
            host: hostOf(deps.rum.location()),
            ...(content?.uiRoot === undefined ? {} : { uiRoot: content.uiRoot }),
          }),
        }
      : {}),
  };
  const viewName = content?.viewName ?? CONTENT_VIEW_NAME;
  const rumOptions: RumOptions | undefined = inContent ? { ...rum, viewName: () => viewName } : rum;
  const t = await setupRumWith(
    {
      ...base,
      ...(inContent ? { instrumentations: { ...base.instrumentations, documentLoad: false } } : {}),
      ...(rumOptions === undefined ? {} : { rum: rumOptions }),
    },
    rumDeps,
  );
  const handle = t as unknown as RumExtensionTelemetry & { shutdown: RumExtensionTelemetry["shutdown"] };
  const rumShutdown = handle.shutdown.bind(handle);
  handle.shutdown = async (opts) => {
    shutDown = true;
    const report = await rumShutdown(opts);
    cache?.close();
    return report;
  };
  return handle;
}

/** Options for setupRumWorker: the worker setup options of `@libo11y/webext` and the gateway's client token. */
export interface RumWorkerSetupOptions extends WorkerSetupOptions {
  readonly rum?: {
    /** The app's public client token for the RUM gateway, sent with sent_at on every request. */
    readonly clientToken?: string;
  };
}

/** What setupRumWorkerWith builds on. Internal: tests replace any of it. */
export interface RumWorkerDeps {
  readonly worker: WorkerDeps;
  /** The fetch the transport posts with. Default the transport's own. */
  readonly fetch?: typeof fetch;
  /** Epoch milliseconds, for sent_at. Default Date.now. */
  readonly now?: () => number;
}

/**
 * Builds the service worker's telemetry for an extension that runs RUM: setupWorker from
 * `@libo11y/webext`, posting to the RUM gateway with the wire parameters sent_at and client_token
 * and app metrics in delta temporality, and allowRumSessionInContentScripts, so content scripts
 * share the extension's session. Call it at the top level of the worker on every wake, as
 * setupWorker.
 */
export function setupRumWorker(options: RumWorkerSetupOptions = {}): Promise<WorkerTelemetry> {
  return setupRumWorkerWith(options, { worker: defaultWorkerDeps() });
}

/** setupRumWorker over deps. Internal: the seam the unit tests use. */
export async function setupRumWorkerWith(
  options: RumWorkerSetupOptions,
  deps: RumWorkerDeps,
): Promise<WorkerTelemetry> {
  const { rum, ...workerOptions } = options;
  const token = rum?.clientToken;
  if (token !== undefined && (typeof token !== "string" || token === "")) {
    throw new O11yError("INVALID_OPTION", "rum.clientToken must be a non-empty string");
  }
  const w = deps.worker;
  // Started before setupWorker awaits anything, so a content script that wakes the worker finds
  // the session open as soon as it can.
  const access =
    w.chrome === undefined
      ? Promise.resolve()
      : allowRumSessionInContentScripts(w.chrome).catch((err: unknown) =>
          diag.warn("o11y: rum: could not open chrome.storage.session to content scripts", err),
        );
  const t = await setupWorkerWith(workerOptions, {
    ...w,
    createHttpTransport: (o) =>
      w.createHttpTransport(
        gatewayTransportOptions(
          deps.fetch === undefined ? o : { ...o, fetch: deps.fetch },
          token,
          deps.now ?? Date.now,
        ),
      ),
    webPlatform: (po) => {
      const platform = w.webPlatform(po);
      return {
        ...platform,
        buildExporters: (req) =>
          createExporterSet(req, po.delivery, po.endpoints, {
            ...(po.mode === undefined ? {} : { mode: po.mode }),
            metricTemporality: "delta",
          }),
      };
    },
  });
  await access;
  return t;
}
