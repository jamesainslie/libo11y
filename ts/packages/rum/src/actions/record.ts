/** Instant actions: custom actions (rum.addAction) and clicks replayed from the bootstrap. */
import {
  ATTR_RUM_ACTION_NAME,
  ATTR_RUM_ACTION_TYPE,
  ATTR_RUM_SPAN_SHAPE,
  ATTR_RUM_VIEW_ID,
  RUM_SPAN_SHAPE_VALUE_ACTION,
  type RUMActionType,
} from "@libo11y/spec";
import { type Attributes, type Link, ROOT_CONTEXT } from "@opentelemetry/api";
import type { RumRuntime } from "../contracts/runtime.ts";

/** The span name of an action: the type only, because span names bypass the sensitivity policy. */
export function actionSpanName(type: RUMActionType): string {
  return `action ${type}`;
}

/** The attributes and links every action span starts with. */
export function actionSpanStart(
  rt: RumRuntime,
  type: RUMActionType,
  name: string | undefined,
  extra: Attributes = {},
): { attributes: Attributes; links: Link[] } {
  const view = rt.views.current();
  return {
    attributes: {
      [ATTR_RUM_SPAN_SHAPE]: RUM_SPAN_SHAPE_VALUE_ACTION,
      [ATTR_RUM_ACTION_TYPE]: type,
      ...(name === undefined ? {} : { [ATTR_RUM_ACTION_NAME]: name }),
      ...(view === undefined ? {} : { [ATTR_RUM_VIEW_ID]: view.id }),
      ...extra,
    },
    links: view?.spanContext === undefined ? [] : [{ context: view.spanContext }],
  };
}

/** Records a zero-length action span at at (performance.now(), default now) and its breadcrumb. */
export function recordInstantAction(
  rt: RumRuntime,
  type: RUMActionType,
  name: string | undefined,
  at: number = rt.now(),
): void {
  const when = rt.timeOrigin + at;
  const span = rt.tracer.startSpan(
    actionSpanName(type),
    { startTime: when, ...actionSpanStart(rt, type, name) },
    ROOT_CONTEXT,
  );
  span.end(when);
  rt.bus.publish({ type: "breadcrumb", kind: type, label: name ?? type, at });
}
