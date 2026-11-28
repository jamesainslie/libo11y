/**
 * The app_load span on React Native (decision N11): once per process, the app's start until its
 * first screen rendered. It starts at performance.rnStartupTiming.startTime when that is a finite
 * time before setup (React Native's measure of the native process start), else when
 * `@libo11y/rum-react-native` was first evaluated. The setup reports every rum.startView and
 * rum.viewRendered here, consent or not, so the first screen's render is known even when consent
 * comes later or after other screens. app_load is recorded when the first grant of the process
 * begins the load view, with its session.id and view ID, and is the load view span's parent
 * (appLoadStarted). It ends at the first screen's render, or capMillis after its start without one,
 * as when the app moved to another screen before the first rendered.
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
  /** The app's start, in performance.now() time: where app_load and the first screen begin. */
  readonly start: number;
  /** Records app_load on runtime when its first grant begins the load view. */
  attach(runtime: RumRuntime): void;
  /** rum.startView was called: the first screen is gone. */
  screenStarted(): void;
  /** rum.viewRendered was called at, in performance.now() time. */
  rendered(at: number): void;
  /** Ends an open app_load now (shutdown) and stops listening. */
  close(): void;
}

export interface AppStartOptions {
  readonly env: RumReactNativeEnv;
  /** performance.now(). */
  readonly now: () => number;
  /** Default APP_LOAD_CAP_MILLIS. */
  readonly capMillis?: number;
}

/** The app start, in performance.now() time: React Native's process start when it is usable. */
function startOf(env: RumReactNativeEnv, now: number): number {
  const s = env.startupTiming?.startTime;
  return typeof s === "number" && Number.isFinite(s) && s >= 0 && s < now ? s : env.loadedAt;
}

export function createAppStart(o: AppStartOptions): AppStart {
  const start = startOf(o.env, o.now());
  const capAt = start + (o.capMillis ?? APP_LOAD_CAP_MILLIS);
  let recorded = false;
  /** The first screen was left before it rendered. */
  let left = false;
  let firstRender: number | undefined;
  let timer: unknown;
  let off: (() => void) | undefined;
  /** Ends the open app_load at a performance.now() time, within its start and cap. */
  let end: ((at: number) => void) | undefined;
  const record = (rt: RumRuntime, viewId: string, sessionId: string): void => {
    recorded = true;
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
    if (firstRender !== undefined) end(firstRender);
    else timer = o.env.setTimeout(() => end?.(capAt), Math.max(0, capAt - o.now()));
  };
  return {
    start,
    attach(rt) {
      off?.();
      off = rt.views.subscribe((e) => {
        if (e.type !== "start" || recorded || e.view.id !== rt.views.loadView()?.id) return;
        record(rt, e.view.id, e.view.sessionId);
      });
    },
    screenStarted() {
      left = true;
    },
    rendered(at) {
      if (left || firstRender !== undefined) return;
      firstRender = at;
      end?.(at);
    },
    close() {
      off?.();
      off = undefined;
      end?.(o.now());
    },
  };
}
