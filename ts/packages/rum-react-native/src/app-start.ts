/**
 * The app_load span on React Native (decision N11): once per process, the app's start until its
 * first screen rendered. It starts at performance.rnStartupTiming.startTime when that is a finite
 * time before now (React Native's measure of the native process start), else when
 * `@libo11y/rum-react-native` was first evaluated. It is recorded when the first grant of the
 * process begins the load view, with its session.id and view ID, so a grant that comes after the
 * first screen still records the cold start: the load view's render, reported before the grant,
 * reaches RUM with its time then. The span is the load view span's parent (appLoadStarted) and ends
 * at that render, or capMillis after its start without one.
 */

import { APP_LOAD_SPAN, ATTR_SESSION_ID, type RumRuntime } from "@libo11y/rum/core";
import {
  ATTR_RUM_PLATFORM,
  ATTR_RUM_SPAN_SHAPE,
  ATTR_RUM_VIEW_ID,
  RUM_SPAN_SHAPE_VALUE_APP_LOAD,
} from "@libo11y/spec";
import { ROOT_CONTEXT, type Span, SpanKind } from "@opentelemetry/api";
import type { RumReactNativeEnv } from "./contracts/env.ts";

/** app_load ends this long after it started at the latest. */
export const APP_LOAD_CAP_MILLIS = 60_000;

/** The app start recorder of one process. */
export interface AppStart {
  /** Records app_load on runtime when its first grant begins the load view. */
  attach(runtime: RumRuntime): void;
  /** Ends an open app_load now (shutdown) and stops listening. */
  close(): void;
}

export interface AppStartOptions {
  readonly env: RumReactNativeEnv;
  /** Default APP_LOAD_CAP_MILLIS. */
  readonly capMillis?: number;
}

/** The app start, in performance.now() time: React Native's process start when it is usable. */
function startOf(env: RumReactNativeEnv, now: number): number {
  const s = env.startupTiming?.startTime;
  return typeof s === "number" && Number.isFinite(s) && s >= 0 && s < now ? s : env.loadedAt;
}

export function createAppStart(o: AppStartOptions): AppStart {
  const cap = o.capMillis ?? APP_LOAD_CAP_MILLIS;
  let recorded = false;
  let timer: unknown;
  let off: (() => void) | undefined;
  /** Ends the open app_load at a performance.now() time, within its start and cap. */
  let end: ((at: number) => void) | undefined;
  let now: (() => number) | undefined;
  const record = (rt: RumRuntime, viewId: string, sessionId: string): void => {
    recorded = true;
    const start = startOf(o.env, rt.now());
    const capAt = start + cap;
    const span: Span = rt.tracer.startSpan(
      APP_LOAD_SPAN,
      {
        kind: SpanKind.INTERNAL,
        startTime: rt.timeOrigin + start,
        attributes: {
          [ATTR_RUM_SPAN_SHAPE]: RUM_SPAN_SHAPE_VALUE_APP_LOAD,
          [ATTR_RUM_PLATFORM]: rt.platform,
          [ATTR_RUM_VIEW_ID]: viewId,
          [ATTR_SESSION_ID]: sessionId,
        },
      },
      ROOT_CONTEXT,
    );
    rt.views.appLoadStarted(span.spanContext());
    end = (at) => {
      end = undefined;
      o.env.clearTimeout(timer);
      span.end(rt.timeOrigin + Math.max(start, Math.min(at, capAt)));
    };
    if (rt.now() >= capAt) end(capAt);
    else timer = o.env.setTimeout(() => end?.(capAt), capAt - rt.now());
  };
  return {
    attach(rt) {
      off?.();
      now = rt.now;
      off = rt.views.subscribe((e) => {
        const load = rt.views.loadView();
        if (load === undefined || e.view.id !== load.id) return;
        if (e.type === "start" && !recorded) record(rt, e.view.id, e.view.sessionId);
        else if (e.type === "rendered") end?.(e.at ?? rt.now());
      });
    },
    close() {
      off?.();
      off = undefined;
      if (now !== undefined) end?.(now());
    },
  };
}
