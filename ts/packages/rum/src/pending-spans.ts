/**
 * Spans that start between a grant and the session loading (R3f). A session store may answer in a
 * later task, as chrome.storage.session does, while web's documentLoad span starts and ends as soon
 * as consent is granted. The span processor holds the spans that start in that window here. Once
 * the session is known, each held span gets session.id and its view's o11y.rum.view.id: at once
 * while it is still recording, and on export once it has ended. An export whose batch holds a span
 * still waiting waits for the session. A revoke closes the window, and the spans that waited go out
 * with no session, so the retention router drops them.
 *
 * Ended spans get their attributes in RUM's forwarding span exporter, so an app that injects only
 * its own span processor (and so exports spans itself) sees ended held spans without them.
 */
import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan, Span } from "@opentelemetry/sdk-trace";

/** At most this many ended spans keep the attributes they are to get on export. */
const STAMPED_LIMIT = 512;
/** At most this many spans wait for one session; later ones go out without it. */
const HELD_LIMIT = 1024;

export interface PendingSpans {
  /** Opens the window: spans that start without a session are held until resolve or discard. */
  open(): void;
  /** The window is open. */
  isOpen(): boolean;
  /** Holds span. load is true for a span of the load view (app_load and its document request). */
  hold(span: Span, load: boolean): void;
  /** The session is known: gives every held span stamp(load), keeping attributes it already has, and closes the window. */
  resolve(stamp: (load: boolean) => Attributes): void;
  /** Closes the window without a session (revoke, shutdown). */
  discard(): void;
  /** spans with each held one stamped. Waits for resolve or discard while one of them is still held. */
  prepare(spans: ReadableSpan[]): ReadableSpan[] | Promise<ReadableSpan[]>;
}

function stamped(span: ReadableSpan, extra: Attributes): ReadableSpan {
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
    attributes: { ...extra, ...span.attributes },
    links: span.links,
    events: span.events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
    ...(span.parentSpanContext === undefined ? {} : { parentSpanContext: span.parentSpanContext }),
  };
}

export function createPendingSpans(): PendingSpans {
  let opened = false;
  const held = new Map<string, { readonly span: Span; readonly load: boolean }>();
  /** Ended spans and the attributes they get on export, oldest first. */
  const late = new Map<string, Attributes>();
  let settle: (() => void) | undefined;
  let settled: Promise<void> | undefined;

  const close = (): void => {
    opened = false;
    held.clear();
    settle?.();
    settle = undefined;
    settled = undefined;
  };
  const patch = (spans: ReadableSpan[]): ReadableSpan[] => {
    if (late.size === 0) return spans;
    return spans.map((s) => {
      const id = s.spanContext().spanId;
      const extra = late.get(id);
      if (extra === undefined) return s;
      late.delete(id);
      return stamped(s, extra);
    });
  };
  const prepare = (spans: ReadableSpan[]): ReadableSpan[] | Promise<ReadableSpan[]> => {
    if (settled !== undefined && spans.some((s) => held.has(s.spanContext().spanId))) {
      return settled.then(() => prepare(spans));
    }
    return patch(spans);
  };

  return {
    open() {
      if (opened) return;
      opened = true;
      settled = new Promise<void>((r) => {
        settle = r;
      });
    },
    isOpen: () => opened,
    hold(span, load) {
      if (opened && held.size < HELD_LIMIT) held.set(span.spanContext().spanId, { span, load });
    },
    resolve(stamp) {
      for (const [id, { span, load }] of held) {
        const attrs = stamp(load);
        if (span.isRecording()) {
          for (const [k, v] of Object.entries(attrs)) {
            if (v !== undefined && span.attributes[k] === undefined) span.setAttribute(k, v);
          }
        } else {
          late.set(id, attrs);
          while (late.size > STAMPED_LIMIT) late.delete(late.keys().next().value as string);
        }
      }
      close();
    },
    discard: close,
    prepare,
  };
}
