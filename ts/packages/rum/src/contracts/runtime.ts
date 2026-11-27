/**
 * Contract, frozen by R3a, extended by R3b. What every collector receives. Collectors are created by factories such
 * as views() and run only while consent is granted: start is called on grant, the returned stop
 * on revoke and shutdown.
 */
import type { LogAttributes, RecordingGate, Telemetry } from "@libo11y/core";
import type { RUMErrorSource, RUMFrustrationType, RUMPlatform } from "@libo11y/spec";
import type { HttpRequestInfo } from "@libo11y/web";
import type { Context, Span, Tracer } from "@opentelemetry/api";
import type { SessionManager } from "./session.ts";
import type { SummaryAccumulator } from "./summary.ts";
import type { ViewTracker } from "./views.ts";

export type CollectorName = "views" | "actions" | "errors" | "vitals" | "resources" | "long_animation_frames";

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
  | { readonly type: "request-end"; readonly spanId: string; readonly status?: number; readonly at: number }
  | { readonly type: "mutation"; readonly at: number }
  | { readonly type: "breadcrumb"; readonly kind: string; readonly label: string; readonly at: number };

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
}

export interface RumRuntime {
  readonly platform: RUMPlatform;
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
   * Emits event name with session.id and o11y.rum.view.id of the current session and view added
   * (attrs win). Dropped while the gate is closed.
   */
  emit(name: string, attrs?: LogAttributes, ctx?: Context): void;
  /** Adds a hook run on every fetch and XHR client span right after it starts. */
  onRequestStart(hook: RequestStartHook): () => void;
  /** The open action's span, while one is open. Requests started meanwhile become its children (R3b). */
  activeAction(): Span | undefined;
  setActiveAction(span: Span | undefined): void;
  /** The last breadcrumbs, oldest first, as "<kind> <label> -<age>ms" (R3b). */
  breadcrumbs(): readonly string[];
}

export interface RumCollector {
  readonly name: CollectorName;
  /** Starts collecting. Returns the function that stops it. */
  start(runtime: RumRuntime): () => void;
}
