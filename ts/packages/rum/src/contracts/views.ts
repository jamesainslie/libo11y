/** Contract, frozen by R3a, extended by R3b. Views: a page or route. performance.now() times. */
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
  | {
      readonly type: "start";
      readonly view: ViewState;
      readonly previous?: ViewState;
      /** The action that caused the view, from ViewStartOptions.cause. */
      readonly cause?: SpanContext;
      /** From ViewStartOptions.rendered: the content is already on screen. */
      readonly rendered?: true;
    }
  | { readonly type: "rename"; readonly view: ViewState }
  /** The routed content of the view rendered (rendered()). */
  | {
      readonly type: "rendered";
      readonly view: ViewState;
      /** performance.now() it rendered at, when that was before now (a render reported before consent). */
      readonly at?: number;
    }
  | { readonly type: "end"; readonly view: ViewState };

export interface ViewStartOptions {
  readonly kind: RUMViewKind;
  /** Default: the tracker's namer applied to location. */
  readonly name?: string;
  /** Default now. */
  readonly startTime?: number;
  /** The action that caused the view, linked from the view span (R3b). */
  readonly cause?: SpanContext;
  /** The view's content is already on screen, as after a session change: its span ends at the next paint. */
  readonly rendered?: boolean;
}

export interface ViewTracker {
  current(): ViewState | undefined;
  /** The view that loaded the page (initial, prerender, or the latest bfcache_restore). Vitals attach to it. */
  loadView(): ViewState | undefined;
  /** Ends the current view and starts another. */
  start(opts: ViewStartOptions): ViewState;
  rename(name: string): void;
  /**
   * The routed view rendered: emits rendered for the current view, whose span ends at the next
   * paint. at (performance.now()) is when it rendered, for a render that happened earlier.
   */
  rendered(at?: number): void;
  /** The span processor reports web's documentLoad span here, so the initial view span can be its child. */
  appLoadStarted(ctx: SpanContext): void;
  /** The context appLoadStarted reported, once it has. */
  appLoad(): SpanContext | undefined;
  /** Records the view span's context on the view, so actions on the view can link to it. */
  attachSpan(viewId: string, ctx: SpanContext): void;
  /** Starts the load view. Called once the session exists. */
  begin(): void;
  /** Ends the current view without starting another (hide is not an end; revoke and shutdown are). */
  end(): void;
  subscribe(listener: (event: ViewEvent) => void): () => void;
}
