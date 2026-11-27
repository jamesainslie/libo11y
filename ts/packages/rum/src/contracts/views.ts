/** Contract, frozen by R3a. Views: a page or route. performance.now() times. */
import type { RUMViewKind } from "@libo11y/spec";
import type { SpanContext } from "@opentelemetry/api";

export interface ViewState {
  readonly id: string;
  readonly name: string;
  readonly kind: RUMViewKind;
  /** performance.now() when the view started. */
  readonly startTime: number;
  /** The session the view belongs to. */
  readonly sessionId: string;
  /** The view span's context, once R3b's tracker has started it. */
  readonly spanContext?: SpanContext;
}

export type ViewEvent =
  | { readonly type: "start"; readonly view: ViewState; readonly previous?: ViewState }
  | { readonly type: "rename"; readonly view: ViewState }
  | { readonly type: "end"; readonly view: ViewState };

export interface ViewStartOptions {
  readonly kind: RUMViewKind;
  /** Default: the tracker's namer applied to location. */
  readonly name?: string;
  /** Default now. */
  readonly startTime?: number;
  /** The action that caused the view, linked from the view span (R3b). */
  readonly cause?: SpanContext;
}

export interface ViewTracker {
  current(): ViewState | undefined;
  /** The view that loaded the page (initial, prerender, or the latest bfcache_restore). Vitals attach to it. */
  loadView(): ViewState | undefined;
  /** Ends the current view and starts another. */
  start(opts: ViewStartOptions): ViewState;
  rename(name: string): void;
  /** The routed view rendered: its span ends at the next paint (R3b). A no-op in R3a. */
  rendered(): void;
  /** The span processor reports web's documentLoad span here, so the initial view span can be its child (R3b). */
  appLoadStarted(ctx: SpanContext): void;
  /** Starts the load view. Called once the session exists. */
  begin(): void;
  /** Ends the current view without starting another (hide is not an end; revoke and shutdown are). */
  end(): void;
  subscribe(listener: (event: ViewEvent) => void): () => void;
}
