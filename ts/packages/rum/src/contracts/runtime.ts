/**
 * What every collector receives. Collectors are created by factories such
 * as views() and run only while consent is granted: start is called on grant, the returned stop
 * on revoke and shutdown.
 */
import type { LogAttributes, RecordingGate, Telemetry } from "@libo11y/core";
import type { RUMErrorSource, RUMFrustrationType, RUMPlatform } from "@libo11y/spec";
import type { HttpRequestInfo } from "@libo11y/web";
import type { Attributes, Context, Span, Tracer } from "@opentelemetry/api";
import type { BootstrapEntry } from "../bootstrap/buffer.ts";
import type { RemoteConfigDocument } from "../config/clamp.ts";
import type { SessionManager } from "./session.ts";
import type { SummaryAccumulator } from "./summary.ts";
import type { ViewTracker } from "./views.ts";

export type CollectorName =
  | "views"
  | "actions"
  | "errors"
  | "vitals"
  | "resources"
  | "long_animation_frames"
  | "replay";

/** Internal signals between collectors. at is performance.now(). */
export type RumSignal =
  | { readonly type: "error"; readonly source: RUMErrorSource; readonly at: number }
  | {
      readonly type: "frustration";
      readonly frustration: RUMFrustrationType;
      readonly selector?: string;
      readonly at: number;
    }
  | {
      readonly type: "request-start";
      readonly spanId: string;
      readonly parentSpanId?: string;
      readonly method: string;
      readonly url: string;
      readonly at: number;
    }
  | {
      readonly type: "request-end";
      readonly spanId: string;
      readonly status?: number;
      /** The span's error.type when it ended without a response, such as AbortError or abort. */
      readonly errorType?: string;
      readonly at: number;
    }
  | { readonly type: "mutation"; readonly at: number }
  | {
      readonly type: "breadcrumb";
      readonly kind: string;
      readonly label: string;
      readonly at: number;
      /** Lets a later rename relabel it: a view start carries its view ID. */
      readonly key?: string;
    }
  /** An event the bootstrap buffered before RUM loaded, replayed once the collectors started. */
  | { readonly type: "bootstrap"; readonly entry: BootstrapEntry };

/** A log record body: the semconv browser.web_vital event carries its fields in one. */
export type EventBody = Readonly<Record<string, string | number>>;

export interface RumBus {
  publish(signal: RumSignal): void;
  subscribe(listener: (signal: RumSignal) => void): () => void;
}

export type RequestStartHook = (span: Span, request: HttpRequestInfo) => void;

/** The options and remote configuration after clamping. */
export interface RumSettings {
  readonly sessionSampleRate: number;
  readonly sessionIdleMillis: number;
  readonly sessionMaxMillis: number;
  readonly queryAllowList: ReadonlySet<string>;
  /** Collectors the app installed and remote configuration left on. */
  readonly enabled: ReadonlySet<CollectorName>;
  readonly configVersion?: string;
  readonly viewName: (url: URL) => string;
  /** The app's public client token, sent as client_token on every gateway request. */
  readonly clientToken?: string;
}

/**
 * What a context limits the collectors to (R3f). Unset fields limit nothing. setupRumExtension sets
 * them in a content script, whose document is the host page's.
 */
export interface RumScope {
  /** actions() records only the click, keydown and submit events this accepts. */
  readonly action?: (event: Event) => boolean;
  /** errors() records only the error, unhandledrejection and securitypolicyviolation events this accepts. */
  readonly error?: (event: Event) => boolean;
  /** views() follows no URL change, so the context keeps one view. */
  readonly fixedView?: boolean;
  /** Attributes every view span carries, such as url.domain in a content script. */
  readonly viewAttributes?: Attributes;
}

export interface RumRuntime {
  readonly platform: RUMPlatform;
  /** The context's limits on what collectors record. Absent on the web. */
  readonly scope?: RumScope;
  readonly telemetry: Telemetry;
  readonly tracer: Tracer;
  readonly gate: RecordingGate;
  readonly session: SessionManager;
  readonly views: ViewTracker;
  readonly summary: SummaryAccumulator;
  readonly bus: RumBus;
  settings(): RumSettings;
  /** performance.now(). */
  now(): number;
  /**
   * The epoch milliseconds now() counts from (performance.timeOrigin on the web), so a span
   * placed at a now() time needs no performance global of its own.
   */
  readonly timeOrigin: number;
  /**
   * Emits event name with session.id and o11y.rum.view.id of the current session and view added
   * (attrs win). Dropped while the gate is closed. With body, the record carries it as its body
   * for upstream events such as semconv's browser.web_vital that define one.
   */
  emit(name: string, attrs?: LogAttributes, ctx?: Context, body?: EventBody): void;
  /** Adds a hook run on every fetch and XHR client span right after it starts. */
  onRequestStart(hook: RequestStartHook): () => void;
  /** The open action's span, while one is open. Requests started meanwhile become its children. */
  activeAction(): Span | undefined;
  setActiveAction(span: Span | undefined): void;
  /** The last breadcrumbs, oldest first, as "<kind> <label> -<age>ms". */
  breadcrumbs(): readonly string[];
  /**
   * Whether url is RUM's own traffic or one the app told the instrumentation to ignore: the OTLP
   * endpoints and instrumentations.ignoreUrls. Resource spans skip these.
   */
  ignored(url: string): boolean;
  /**
   * Adds a hook run when the page is hidden (the first of visibilitychange to hidden and pagehide,
   * once per hide), before the summaries are emitted and exported. Returns a function that
   * removes it.
   */
  onHide(hook: () => void): () => void;
  /**
   * The remote configuration document the current session started under, if any: the one
   * settings() applies, for a collector that reads keys of its own, such as replay.
   */
  remoteDocument(): RemoteConfigDocument | undefined;
  /**
   * Adds attributes to every event of the given names that emit sends. attrs runs at each
   * emit; undefined adds nothing, and the caller's attributes win on a conflict. Returns a
   * function that removes it.
   */
  addEventAttributes(names: readonly string[], attrs: () => LogAttributes | undefined): () => void;
  /**
   * Counts url as RUM's own traffic, whatever its query and fragment, so ignored is true for it,
   * as for the OTLP endpoints. Returns a function that removes it.
   */
  ignoreUrl(url: string): () => void;
}

export interface RumCollector {
  readonly name: CollectorName;
  /** Starts collecting. Returns the function that stops it. */
  start(runtime: RumRuntime): () => void;
}
