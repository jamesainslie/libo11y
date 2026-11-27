/**
 * actions(): user actions and frustration signals.
 *
 * Listens on window in the capture phase. A click is a click action on its actionTarget. Enter or
 * Space on a control that is not a text field (an input that takes text, a textarea or
 * contenteditable) is a key_press action; the key itself is never recorded. A submit is a submit
 * action on its form, except when it belongs to the gesture of the click or key press just before
 * it (within GESTURE_MILLIS), and a keyboard click (detail 0) that follows a key press is that
 * key press's gesture too.
 *
 * Each new action ends the open one at its last activity, then starts the span "action <type>" as
 * a root at the event's time, with o11y.rum.span.shape action, the type, the name (actionName,
 * when there is one), o11y.rum.element.selector and the view ID, linked to the view span. It is
 * the open action until it settles (decision P10): the RUM context manager makes it the parent of
 * requests started meanwhile, and the requests whose parent it is, DOM mutations and view starts
 * are its activity. Its breadcrumb (type and name, else the tag) is published when it starts.
 *
 * Frustration (decision P11, frustration not false): clicks feed rage and dead detection, and
 * errors feed error clicks. A click is not dead-eligible on a form field, label, contenteditable,
 * a link with an href, or inside a text selection. Requests, mutations and view starts within the
 * dead window count as activity, so the mutation observer stays connected while an action is open
 * or a dead window is. Each signal counts in the summary, is published, retains the session and is
 * emitted as o11y.rum.frustration in the open action's context. Stop removes every listener, ends
 * the open action and cancels every timer.
 */
import {
  ATTR_RUM_ELEMENT_SELECTOR,
  ATTR_RUM_FRUSTRATION_TYPE,
  EVENT_RUM_FRUSTRATION,
  type RUMActionType,
  type RUMFrustrationType,
} from "@libo11y/spec";
import { context, ROOT_CONTEXT, type Span, trace } from "@opentelemetry/api";
import type { RumCollector, RumRuntime } from "../contracts/runtime.ts";
import { createFrustrationDetector, type FrustrationDetector } from "../frustration/detect.ts";
import { MUTATIONS, type MutationObserverCtor, type MutationObserverLike } from "../views/collector.ts";
import { actionName, actionTarget, type CssEscape, elementSelector } from "./naming.ts";
import { actionSpanName, actionSpanStart } from "./record.ts";
import { createSettleTracker, type SettleTracker } from "./settle.ts";

export interface ActionsOptions {
  /** How long the page must be idle before an action settles. Default 100. */
  readonly idleMillis?: number;
  /** An action ends this long after it started at the latest. Default 10000. */
  readonly capMillis?: number;
  /** Detect rage, dead and error clicks. Default true. */
  readonly frustration?: boolean;
}

/** What actions() needs from the page. Internal: tests inject a fake. */
export interface ActionsEnv {
  /** performance.timeOrigin. */
  readonly timeOrigin: number;
  readonly window: EventTarget;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  readonly MutationObserver?: MutationObserverCtor;
  readonly root?: object;
  readonly cssEscape?: CssEscape;
  /** True while the page has a text selection that is not collapsed. */
  selecting(): boolean;
}

/** Events of one gesture (a click and the submit it causes) come this close together. */
export const GESTURE_MILLIS = 100;
const FRUSTRATION_WINDOW_MILLIS = 1000;
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);
const NOT_DEAD = "input,select,textarea,label,[contenteditable]";

function isElement(v: unknown): v is Element {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Element).closest === "function" &&
    typeof (v as Element).tagName === "string"
  );
}

function isTextField(el: Element): boolean {
  const tag = el.tagName;
  if (tag === "TEXTAREA" || (el as HTMLElement).isContentEditable === true) return true;
  if (tag !== "INPUT") return false;
  return TEXT_INPUT_TYPES.has((el.getAttribute("type") ?? "").toLowerCase());
}

interface OpenAction {
  readonly span: Span;
  readonly type: RUMActionType;
  readonly start: number;
  readonly settle: SettleTracker;
}

export function actionsWith(opts: ActionsOptions, env: ActionsEnv): RumCollector {
  const idleMillis = opts.idleMillis ?? 100;
  const capMillis = opts.capMillis ?? 10_000;
  return {
    name: "actions",
    start(rt: RumRuntime) {
      let current: OpenAction | undefined;
      let observer: MutationObserverLike | undefined;
      /** The observer stays connected until then, or while an action is open. */
      let watchUntil = 0;
      let watchTimer: unknown;

      const unwatch = (): void => {
        if (current !== undefined || rt.now() < watchUntil) return;
        observer?.disconnect();
        observer = undefined;
      };
      const watch = (until: number): void => {
        watchUntil = Math.max(watchUntil, until);
        if (watchTimer !== undefined) env.clearTimeout(watchTimer);
        watchTimer = env.setTimeout(
          () => {
            watchTimer = undefined;
            unwatch();
          },
          Math.max(0, watchUntil - rt.now()),
        );
        if (observer !== undefined || env.MutationObserver === undefined || env.root === undefined) return;
        observer = new env.MutationObserver(() => rt.bus.publish({ type: "mutation", at: rt.now() }));
        observer.observe(env.root, MUTATIONS);
      };

      const signal = (type: RUMFrustrationType, selector: string, at: number): void => {
        rt.summary.count(`frustrations.${type}`);
        rt.bus.publish({ type: "frustration", frustration: type, selector, at });
        rt.session.retain("frustration");
        const action = current?.span;
        rt.emit(
          EVENT_RUM_FRUSTRATION,
          { [ATTR_RUM_FRUSTRATION_TYPE]: type, [ATTR_RUM_ELEMENT_SELECTOR]: selector },
          action === undefined ? undefined : trace.setSpan(context.active(), action),
        );
      };
      const detector: FrustrationDetector | undefined =
        opts.frustration === false ? undefined : createFrustrationDetector({ timers: env, onSignal: signal });

      const begin = (type: RUMActionType, target: Element, timeStamp: number): Element => {
        current?.settle.end();
        const now = rt.now();
        // Some engines stamp events in epoch milliseconds; anything not on the performance clock is now.
        const start = Number.isFinite(timeStamp) && timeStamp > 0 && timeStamp <= now ? timeStamp : now;
        const el = type === "submit" ? target : actionTarget(target);
        const name = actionName(el);
        const selector = elementSelector(el, env.cssEscape);
        const span = rt.tracer.startSpan(
          actionSpanName(type),
          {
            startTime: env.timeOrigin + start,
            ...actionSpanStart(rt, type, name, { [ATTR_RUM_ELEMENT_SELECTOR]: selector }),
          },
          ROOT_CONTEXT,
        );
        const settle = createSettleTracker({
          start,
          idleMillis,
          capMillis,
          now: rt.now,
          timers: env,
          onSettle: (end) => {
            span.end(env.timeOrigin + end);
            if (current?.span === span) current = undefined;
            if (rt.activeAction() === span) rt.setActiveAction(undefined);
            unwatch();
          },
        });
        current = { span, type, start, settle };
        rt.setActiveAction(span);
        rt.session.touch();
        rt.bus.publish({
          type: "breadcrumb",
          kind: type,
          label: name ?? el.tagName.toLowerCase(),
          at: start,
        });
        watch(start + (detector === undefined ? 0 : FRUSTRATION_WINDOW_MILLIS));
        if (type === "click" && detector !== undefined) {
          const eligible =
            target.closest(NOT_DEAD) === null &&
            (target as HTMLElement).isContentEditable !== true &&
            target.closest("a")?.getAttribute("href") == null &&
            !env.selecting();
          detector.click(selector, start, eligible);
        }
        return el;
      };
      const sameGesture = (timeStamp: number): boolean =>
        current !== undefined && timeStamp - current.start < GESTURE_MILLIS;

      const onClick = (e: Event): void => {
        if (!isElement(e.target)) return;
        if ((e as MouseEvent).detail === 0 && current?.type === "key_press") return;
        begin("click", e.target, e.timeStamp);
      };
      const onKey = (e: Event): void => {
        const k = e as KeyboardEvent;
        if (k.repeat === true || (k.key !== "Enter" && k.key !== " ")) return;
        if (!isElement(e.target) || isTextField(e.target)) return;
        begin("key_press", e.target, e.timeStamp);
      };
      const onSubmit = (e: Event): void => {
        if (!isElement(e.target)) return;
        if ((current?.type === "click" || current?.type === "key_press") && sameGesture(e.timeStamp)) return;
        begin("submit", e.target, e.timeStamp);
      };
      env.window.addEventListener("click", onClick, { capture: true });
      env.window.addEventListener("keydown", onKey, { capture: true });
      env.window.addEventListener("submit", onSubmit, { capture: true });

      const offBus = rt.bus.subscribe((s) => {
        const a = current;
        if (s.type === "request-start") {
          if (a !== undefined && s.parentSpanId === a.span.spanContext().spanId) {
            a.settle.requestStarted(s.spanId, s.at);
          }
          detector?.activity(s.at);
        } else if (s.type === "request-end") a?.settle.requestEnded(s.spanId, s.at);
        else if (s.type === "mutation") {
          a?.settle.activity(s.at);
          detector?.activity(s.at);
        } else if (s.type === "error") detector?.error(s.at, a !== undefined);
      });
      const offViews = rt.views.subscribe((e) => {
        if (e.type !== "start") return;
        current?.settle.activity(rt.now());
        detector?.activity(rt.now());
      });

      return () => {
        env.window.removeEventListener("click", onClick, { capture: true });
        env.window.removeEventListener("keydown", onKey, { capture: true });
        env.window.removeEventListener("submit", onSubmit, { capture: true });
        offBus();
        offViews();
        current?.settle.end();
        current = undefined;
        detector?.stop();
        if (watchTimer !== undefined) env.clearTimeout(watchTimer);
        watchUntil = 0;
        observer?.disconnect();
        observer = undefined;
      };
    },
  };
}

function browserActionsEnv(): ActionsEnv {
  const g = globalThis as typeof globalThis & { document?: Document };
  const doc = g.document;
  return {
    timeOrigin: performance.timeOrigin,
    window: g,
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    ...(typeof g.MutationObserver === "function" ? { MutationObserver: g.MutationObserver } : {}),
    ...(doc?.documentElement == null ? {} : { root: doc.documentElement }),
    selecting: () => {
      const sel = doc?.getSelection?.();
      return sel != null && !sel.isCollapsed;
    },
  };
}

/** The actions collector: clicks, key presses and submits as action spans, and frustration signals. */
export function actions(opts: ActionsOptions = {}): RumCollector {
  return { name: "actions", start: (rt) => actionsWith(opts, browserActionsEnv()).start(rt) };
}
