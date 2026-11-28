/**
 * Contract, R3f extended by R5a. A platform binding: what setupRumCore hands the platform it runs
 * on, and what the platform reports back. The web binding (bind.ts) runs @libo11y/web's setup, the
 * extension binding @libo11y/webext's content script setup. A binding runs nothing at module
 * evaluation and needs no browser global of its own, so a platform without a DOM can supply one.
 */
import type { ExporterSet, Telemetry } from "@libo11y/core";
import type {
  ConsentController,
  Delivery,
  HttpTransportOptions,
  SendMode,
  SignalEndpoints,
  UrlMatcher,
} from "@libo11y/web/portable";
import type { ContextManager } from "@opentelemetry/api";
import type { SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace";
import type { RequestStartHook } from "./runtime.ts";

/** The parts of a platform's setup options RUM reads. WebSetupOptions has every one. */
export interface RumPlatformOptions {
  readonly hermetic?: boolean;
  readonly spanExporter?: SpanExporter;
  readonly spanProcessor?: SpanProcessor;
  readonly contextManager?: () => ContextManager;
  readonly transport?: { readonly timeoutMillis?: number };
  readonly instrumentations?: { readonly ignoreUrls?: readonly UrlMatcher[] };
}

/** What a platform reports once it built its delivery, before core builds anything. */
export interface RumPlatformInfo {
  readonly endpoints: SignalEndpoints;
  readonly delivery: Delivery;
  /** The send mode, for the exporters' unload splitting. Default `() => "normal"`. */
  readonly mode?: () => SendMode;
}

/** What the RUM core hands a platform binding, to wrap the parts of the platform's setup RUM needs. */
export interface RumWrappers {
  /** Takes the consent controller the platform built; RUM's gate. Returns the controller to use. */
  readonly consentController: (c: ConsentController) => ConsentController;
  /**
   * Takes the platform's delivery and endpoints, and the OTEL_* variables it reports, before core
   * builds anything, for RUM's span exporter and retention flush.
   */
  readonly platform: (info: RumPlatformInfo, env: Readonly<Record<string, string>>) => void;
  /** Routes the platform's exporter set by session. Build it with delta metric temporality, as the gateway needs. */
  readonly exporterSet: (set: ExporterSet) => ExporterSet;
  /** RUM's hook, for the fetch and XHR instrumentation's onStart. */
  readonly onRequestStart: RequestStartHook;
  /** Adds the gateway wire parameters to an HTTP transport, for a binding that sends over HTTP. */
  readonly transportOptions: (o: HttpTransportOptions) => HttpTransportOptions;
}

/**
 * Runs a platform's setup with RUM's wrappers. options are the platform's own, with RUM's span
 * processor, context manager and forwarding span exporter in place.
 */
export type RumBind<O extends RumPlatformOptions, T extends Telemetry> = (
  options: O,
  wrappers: RumWrappers,
) => Promise<T>;

/**
 * What RUM does on the platform's lifecycle signals. Each is called unbound, with any arguments
 * ignored, so a binding may add one as an event listener directly.
 */
export interface RumLifecycleHandlers {
  /**
   * The page or app is being hidden. One hide may signal more than once, as a page's pagehide and
   * then visibilitychange: RUM runs its hide hooks on the first and sends what is pending on each.
   */
  readonly hide: () => void;
  /** Visible again after a hide. */
  readonly show: () => void;
  /** A page hidden into the back/forward cache is back: its next hide is a new hide, even without a show. */
  readonly restore: () => void;
}

/** When the page or app is on screen, as its platform reports it. RUM calls each member unbound. */
export interface RumLifecycle {
  /** False while the page is hidden or the app is in the background. */
  readonly visible: () => boolean;
  /**
   * Calls handlers on the platform's lifecycle signals. RUM subscribes before the binding runs the
   * platform's setup, so RUM's hide work runs before a flush on hide the platform subscribes.
   * Returns the function that unsubscribes.
   */
  readonly subscribe: (handlers: RumLifecycleHandlers) => () => void;
  /** Calls listener on user activity, which keeps the session alive. Returns the function that unsubscribes. */
  readonly activity?: (listener: () => void) => () => void;
}
