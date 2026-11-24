/**
 * Span enforcement. An ended span is immutable, so redaction presents a view of it with the policy
 * applied to the span's, its events' and its links' attributes, and every other member delegated.
 * Keys are flat; map-valued attributes are judged on their own key.
 *
 * Documented gap: an injected span processor sees the live, unredacted span in onStart and in
 * onEnding (the span is still mutable there, so no view can stand in for it); only onEnd gets the
 * redacted view. Go's processor has the same gap in OnStart.
 */
import type { Attributes, Context, Link } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, Span, SpanExporter, SpanProcessor, TimedEvent } from "@opentelemetry/sdk-trace";
import type { SensitivityPolicy } from "./policy.ts";

function redactAttributes(policy: SensitivityPolicy, attrs: Attributes | undefined): Attributes | undefined {
  return attrs === undefined ? undefined : policy.attributes("traces", attrs);
}

/** Returns span with the policy applied, or span itself when nothing changes. */
export function redactSpan(span: ReadableSpan, policy: SensitivityPolicy): ReadableSpan {
  const attributes = policy.attributes("traces", span.attributes);
  let changed = attributes !== span.attributes;
  const events = span.events.map((e): TimedEvent => {
    const a = redactAttributes(policy, e.attributes);
    if (a === e.attributes) return e;
    changed = true;
    return { ...e, attributes: a ?? {} };
  });
  const links = span.links.map((l): Link => {
    const a = redactAttributes(policy, l.attributes);
    if (a === l.attributes) return l;
    changed = true;
    return { ...l, attributes: a ?? {} };
  });
  if (!changed) return span;
  const view: ReadableSpan = {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
    attributes,
    links,
    events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
    ...(span.parentSpanContext === undefined ? {} : { parentSpanContext: span.parentSpanContext }),
  };
  return view;
}

/**
 * Wraps inner so every exported span is redacted first. The policy counts each dropped or rewritten
 * attribute once, on the traces signal.
 */
export function redactingSpanExporter(inner: SpanExporter, policy: SensitivityPolicy): SpanExporter {
  return {
    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
      inner.export(
        spans.map((s) => redactSpan(s, policy)),
        resultCallback,
      );
    },
    shutdown: () => inner.shutdown(),
    forceFlush: async () => {
      await inner.forceFlush?.();
    },
  };
}

/**
 * Wraps a caller's span processor: onStart and onEnding see the live span (onStart as Go's does),
 * and onEnd the redacted view. Pass policy.silent() when an exporter also redacts, so one attribute counts once.
 */
export function redactingSpanProcessor(inner: SpanProcessor, policy: SensitivityPolicy): SpanProcessor {
  const processor: SpanProcessor = {
    onStart: (span: Span, parentContext: Context) => inner.onStart(span, parentContext),
    onEnd: (span: ReadableSpan) => inner.onEnd(redactSpan(span, policy)),
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
  };
  if (inner.onEnding !== undefined) {
    const onEnding = inner.onEnding.bind(inner);
    processor.onEnding = (span: Span) => onEnding(span);
  }
  return processor;
}
