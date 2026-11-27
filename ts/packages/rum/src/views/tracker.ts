/**
 * The view tracker: the initial (or prerender) view at begin, a bfcache_restore view on a
 * persisted pageshow, a soft view of the same name when the session changes (decision P14), and
 * the soft views views() and the router adapters start. Every view opens in the summary
 * accumulator and closes when it ends. views() records the view spans and attaches their contexts.
 */

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
  /** document.prerendering, or a navigation entry with activationStart > 0. */
  readonly prerendered: () => boolean;
  /** Where pageshow fires, for back/forward-cache restores. */
  readonly window?: EventTarget;
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

  const start = (o: ViewStartOptions): ViewState => {
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
    if (LOAD_KINDS.has(view.kind)) load = view;
    opts.summary.open(view);
    emit({
      type: "start",
      view,
      ...(previous === undefined ? {} : { previous }),
      ...(o.cause === undefined ? {} : { cause: o.cause }),
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
    if (current.sessionId !== e.session.id) start({ kind: "soft", name: current.name });
  });

  return {
    current: () => current,
    loadView: () => load,
    start,
    rename(name) {
      if (current === undefined) return;
      current = { ...current, name };
      if (load?.id === current.id) load = current;
      opts.summary.rename(current.id, name);
      emit({ type: "rename", view: current });
    },
    rendered() {
      if (current !== undefined) emit({ type: "rendered", view: current });
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
      // The initial view starts at time origin: a view covers getting into it from navigation start.
      if (current === undefined) start({ kind: opts.prerendered() ? "prerender" : "initial", startTime: 0 });
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
