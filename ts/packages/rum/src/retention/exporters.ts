/**
 * The retention router (decision P2). Wraps the exporters @libo11y/web builds, so each batch is
 * split by the session.id of its records: kept sessions go to the inner exporter, the current
 * unkept session is serialized into the retention buffer, and an old unkept session is dropped.
 * Every o11y.rum.view.summary record goes to the inner exporter, because summaries are sent for
 * every consented session. Metrics pass through untouched.
 */
import type { ExporterSet } from "@libo11y/core";
import { EVENT_RUM_VIEW_SUMMARY } from "@libo11y/spec";
import { serializeLogs, serializeSpans } from "@libo11y/web/portable";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";
import { ATTR_SESSION_ID } from "../attrs.ts";
import type { RetentionRouting } from "../contracts/retention.ts";
import type { SessionDecision } from "../contracts/session.ts";

const SUCCESS: ExportResult = { code: ExportResultCode.SUCCESS };

function sessionOf(attrs: Readonly<Record<string, unknown>>): string | undefined {
  const v = attrs[ATTR_SESSION_ID];
  return typeof v === "string" ? v : undefined;
}

function partition<T>(items: readonly T[], route: (item: T) => SessionDecision): { send: T[]; buffer: T[] } {
  const send: T[] = [];
  const buffer: T[] = [];
  for (const item of items) {
    const r = route(item);
    if (r === "send") send.push(item);
    else if (r === "buffer") buffer.push(item);
  }
  return { send, buffer };
}

/** A SpanExporter that routes each span by its session.id. */
export function retainingSpanExporter(inner: SpanExporter, routing: RetentionRouting): SpanExporter {
  return {
    export(spans: ReadableSpan[], done: (r: ExportResult) => void) {
      const { send, buffer } = partition(spans, (s) => routing.decide(sessionOf(s.attributes)));
      if (buffer.length > 0) routing.buffer({ signal: "traces", body: serializeSpans(buffer) });
      if (send.length === 0) done(SUCCESS);
      else inner.export(send, done);
    },
    shutdown: () => inner.shutdown(),
    ...(inner.forceFlush === undefined
      ? {}
      : { forceFlush: () => inner.forceFlush?.() ?? Promise.resolve() }),
  };
}

/** A LogRecordExporter that routes each record by its session.id, sending every view summary. */
export function retainingLogExporter(inner: LogRecordExporter, routing: RetentionRouting): LogRecordExporter {
  return {
    export(records: ReadableLogRecord[], done: (r: ExportResult) => void) {
      const { send, buffer } = partition(records, (l) =>
        l.attributes["event.name"] === EVENT_RUM_VIEW_SUMMARY
          ? "send"
          : routing.decide(sessionOf(l.attributes)),
      );
      if (buffer.length > 0) routing.buffer({ signal: "logs", body: serializeLogs(buffer) });
      if (send.length === 0) done(SUCCESS);
      else inner.export(send, done);
    },
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush(),
  };
}

/** The exporter set with traces and logs routed by session. The metric reader is unchanged. */
export function withRetention(set: ExporterSet, routing: RetentionRouting): ExporterSet {
  return {
    ...set,
    ...(set.spanExporter === undefined
      ? {}
      : { spanExporter: retainingSpanExporter(set.spanExporter, routing) }),
    ...(set.logExporter === undefined ? {} : { logExporter: retainingLogExporter(set.logExporter, routing) }),
  };
}
