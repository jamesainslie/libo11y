/**
 * The one path every error takes, from the errors() collector and from rum.addError: it is counted
 * in the current view's summary for every consented session, published on the bus for frustration
 * detection, retains the session (decision P12), and is emitted as o11y.rum.error (detail, so it is
 * buffered for an unkept session) with the breadcrumbs, at most 100 events per view. An error while
 * an action is open is emitted in the action's context.
 */
import {
  ATTR_RUM_ERROR_BREADCRUMBS,
  ATTR_RUM_ERROR_SOURCE,
  EVENT_RUM_ERROR,
  type RUMErrorSource,
} from "@libo11y/spec";
import { context, trace } from "@opentelemetry/api";
import type { RumRuntime } from "../contracts/runtime.ts";
import { normalizeError } from "./normalize.ts";

/** The most o11y.rum.error events one view emits. Later errors still count in its summary. */
export const MAX_ERROR_EVENTS_PER_VIEW = 100;

const emitted = new WeakMap<RumRuntime, { viewId: string; n: number }>();

export interface ErrorExtra {
  /** A UI framework's component stack, appended to the stack. */
  readonly componentStack?: string;
  /** performance.now() when it happened. Default now. */
  readonly at?: number;
}

export function recordError(
  rt: RumRuntime,
  source: RUMErrorSource,
  error: unknown,
  extra: ErrorExtra = {},
): void {
  const at = extra.at ?? rt.now();
  rt.summary.count(`errors.${source}`);
  rt.bus.publish({ type: "error", source, at });
  rt.session.retain("error");
  const viewId = rt.views.current()?.id ?? "";
  const seen = emitted.get(rt);
  const n = seen?.viewId === viewId ? seen.n : 0;
  if (n >= MAX_ERROR_EVENTS_PER_VIEW) return;
  emitted.set(rt, { viewId, n: n + 1 });
  const e = normalizeError(error);
  const stack = extra.componentStack === undefined ? e.stack : `${e.stack ?? ""}\n${extra.componentStack}`;
  const crumbs = rt.breadcrumbs();
  const action = rt.activeAction();
  rt.emit(
    EVENT_RUM_ERROR,
    {
      [ATTR_RUM_ERROR_SOURCE]: source,
      "exception.type": e.type,
      "exception.message": e.message,
      ...(stack === undefined ? {} : { "exception.stacktrace": stack }),
      ...(crumbs.length === 0 ? {} : { [ATTR_RUM_ERROR_BREADCRUMBS]: crumbs.join("\n") }),
    },
    action === undefined ? undefined : trace.setSpan(context.active(), action),
  );
}
