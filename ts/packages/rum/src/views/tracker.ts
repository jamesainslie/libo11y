/**
 * The view tracker: the initial (or prerender) view at begin, a bfcache_restore view on a
 * persisted pageshow, a soft view of the same name when the session changes (decision P14), and
 * the soft views views() and the router adapters start. A platform whose views are all of one
 * kind, as React Native's screens, passes viewKind: the first begin's view is then the load view and
 * every view has that kind. Every view opens in the summary accumulator and closes when it ends.
 * views() records the view spans and attaches their contexts.
 */
import type { RUMViewKind } from "@libo11y/spec";

import type { SpanContext } from "@opentelemetry/api";
import type { SessionManager } from "../contracts/session.ts";
import type { SummaryAccumulator } from "../contracts/summary.ts";
import type { ViewEvent, ViewStartOptions, ViewState, ViewTracker } from "../contracts/views.ts";
import { randomUuid } from "../ids.ts";

export interface ViewTrackerOptions {
  readonly session: Pick<SessionManager, "current" | "subscribe">;
  readonly summary: SummaryAccumulator;
  readonly viewName: (url: URL) => string;
  /** The page URL now. */
  readonly location: () => string;
  /** performance.now(). */
  readonly now: () => number;
  /** document.prerendering, or a navigation entry with `activationStart > 0`. */
  readonly prerendered: () => boolean;
  /** Where pageshow fires, for back/forward-cache restores. */
  readonly window?: EventTarget;
  /** When the initial view starts, performance.now(). Default 0, navigation start; a content script's view starts when RUM begins. */
  readonly initialStart?: () => number;
  /**
   * The kind of every view the tracker starts itself (the load view, the view of a session change
   * and of a later begin), for a platform with one kind of view, such as React Native's screen.
   * Default the web's: initial or prerender, then soft.
   */
  readonly viewKind?: RUMViewKind;
  readonly randomId?: () => string;
}

const LOAD_KINDS: ReadonlySet<string> = new Set(["initial", "prerender", "bfcache_restore"]);

export function createViewTracker(opts: ViewTrackerOptions): ViewTracker & { close(): void } {
  const randomId = opts.randomId ?? randomUuid;
  const listeners = new Set<(e: ViewEvent) => void>();
  let current: ViewState | undefined;
  let load: ViewState | undefined;
  let appLoad: SpanContext | undefined;
  const emit = (e: ViewEvent): void => {
    for (const l of listeners) l(e);
  };

  const endCurrent = (): ViewState | undefined => {
    const ended = current;
    if (ended === undefined) return undefined;
    current = undefined;
    opts.summary.close(ended.id);
    emit({ type: "end", view: ended });
    return ended;
  };

  const later: RUMViewKind = opts.viewKind ?? "soft";
  /** Starts a view; asLoad makes it the load view. */
  const start = (o: ViewStartOptions, asLoad = LOAD_KINDS.has(o.kind)): ViewState => {
    const previous = endCurrent();
    const session = opts.session.current();
    const view: ViewState = {
      id: randomId(),
      name: o.name ?? opts.viewName(new URL(opts.location())),
      kind: o.kind,
      startTime: o.startTime ?? opts.now(),
      sessionId: session?.id ?? "",
    };
    if (session === undefined) return view; // no consent: nothing is tracked
    current = view;
    if (asLoad) load = view;
    opts.summary.open(view);
    emit({
      type: "start",
      view,
      ...(previous === undefined ? {} : { previous }),
      ...(o.cause === undefined ? {} : { cause: o.cause }),
      ...(o.rendered === true ? { rendered: true as const } : {}),
    });
    return view;
  };

  const onPageShow = (e: Event): void => {
    if ((e as Event & { persisted?: boolean }).persisted === true && current !== undefined) {
      start({ kind: "bfcache_restore", name: current.name });
    }
  };
  opts.window?.addEventListener("pageshow", onPageShow);

  const unsubscribe = opts.session.subscribe((e) => {
    if (e.type !== "start" || e.previous === undefined || current === undefined) return;
    if (current.sessionId !== e.session.id) start({ kind: later, name: current.name, rendered: true });
  });

  return {
    current: () => current,
    loadView: () => load,
    start: (o) => start(o),
    rename(name) {
      if (current === undefined) return;
      current = { ...current, name };
      if (load?.id === current.id) load = current;
      opts.summary.rename(current.id, name);
      emit({ type: "rename", view: current });
    },
    rendered(at) {
      if (current !== undefined)
        emit({ type: "rendered", view: current, ...(at === undefined ? {} : { at }) });
    },
    appLoadStarted(ctx) {
      appLoad = ctx;
    },
    appLoad: () => appLoad,
    attachSpan(viewId, ctx) {
      if (current?.id === viewId) current = { ...current, spanContext: ctx };
      if (load?.id === viewId) load = { ...load, spanContext: ctx };
    },
    begin() {
      if (current !== undefined) return;
      // The initial view starts at time origin: a view covers getting into it from navigation start.
      // A later begin (consent granted again) is a new session on a page already loaded, so its
      // view is soft and starts now (decision P14).
      if (load === undefined) {
        const kind = opts.viewKind ?? (opts.prerendered() ? "prerender" : "initial");
        start({ kind, startTime: opts.initialStart?.() ?? 0 }, true);
      } else start({ kind: later, name: load.name });
    },
    end() {
      endCurrent();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      opts.window?.removeEventListener("pageshow", onPageShow);
      unsubscribe();
      listeners.clear();
    },
  };
}
