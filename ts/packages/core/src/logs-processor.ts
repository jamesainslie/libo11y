/**
 * Log enforcement for records from other bridges on the libo11y LoggerProvider. Registered before
 * the batch processor, it classifies each record's attributes in place, walking map values on their
 * dotted keys. Records the libo11y logger emits carry the classified mark and are skipped: the
 * logger classifies each sink itself, so classifying again would hash a token. The body is not
 * classified.
 *
 * sdk-logs 3.1.1 has no API to remove an attribute. The processor deletes the key from
 * record.attributes during onEmit, which sdk-logs allows (a processor "may freely modify logRecord
 * for the duration of the OnEmit call"); the probe in logs-processor.test.ts proves the export then
 * lacks it. The record's attribute-count limit is not decremented for a deleted key.
 */
import { type Context, context, createContextKey } from "@opentelemetry/api";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { Coalesced } from "./internal/coalesce.ts";
import type { LogAttributes } from "./log-values.ts";
import type { SensitivityPolicy } from "./policy.ts";

/** Marks a context whose log record the libo11y logger has already classified. */
export const CLASSIFIED_KEY: symbol = createContextKey("libo11y.log.classified");

/** Returns ctx marked as carrying a record the libo11y logger classified. */
export function markClassified(ctx: Context): Context {
  return ctx.setValue(CLASSIFIED_KEY, true);
}

/** Reports whether ctx carries the classified mark. */
export function isClassified(ctx: Context): boolean {
  return ctx.getValue(CLASSIFIED_KEY) === true;
}

/** Applies the sensitivity policy to every bridge record the LoggerProvider emits. */
export class RedactingLogRecordProcessor implements LogRecordProcessor {
  private readonly policy: SensitivityPolicy;

  constructor(policy: SensitivityPolicy) {
    this.policy = policy;
  }

  onEmit(record: ReadWriteLogRecord, ctx?: Context): void {
    if (isClassified(ctx ?? context.active())) return;
    const attrs = record.attributes as Record<string, unknown>;
    const out = this.policy.logAttributes(attrs as LogAttributes) as Record<string, unknown>;
    if (out === attrs) return;
    for (const key of Object.keys(attrs)) {
      if (!Object.hasOwn(out, key)) delete attrs[key];
    }
    for (const [key, value] of Object.entries(out)) {
      if (attrs[key] !== value) record.setAttribute(key, value);
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

/**
 * Keeps the flushes of a log record processor from overlapping, and its shutdown from overlapping
 * a flush.
 *
 * Upstream's BatchLogRecordProcessor returns at once from a forceFlush that overlaps another, and
 * sends the batches of the running one in turn. A caller whose record sat in a later batch, or was
 * emitted while the other flush ran, got a resolved promise with the record unsent. Its shutdown
 * skips the flush in the same way, then stops the exporter under the running flush, and what was
 * emitted meanwhile is never sent.
 *
 * Here a forceFlush that arrives while one runs shares, with the others that arrive, one follow-up
 * flush that starts when the running one ends. When forceFlush resolves, every record emitted
 * before the call has been handed to the exporter and its export has settled. A caller waits for
 * the rest of one flush and one more, never longer. This holds for every caller, whether it comes
 * through Telemetry.forceFlush or through the logger provider.
 *
 * The span processor and the metric reader need none of this. Upstream's BatchSpanProcessor hands
 * every buffered batch to the exporter before forceFlush returns, and its
 * PeriodicExportingMetricReader waits for the collection under way and then runs, or joins, one
 * that began later.
 */
export class CoalescingLogRecordProcessor implements LogRecordProcessor {
  private readonly inner: LogRecordProcessor;
  private readonly flushes: Coalesced;

  constructor(inner: LogRecordProcessor) {
    this.inner = inner;
    this.flushes = new Coalesced(() => inner.forceFlush());
  }

  onEmit(record: ReadWriteLogRecord, ctx?: Context): void {
    this.inner.onEmit(record, ctx);
  }

  /** As the provider reads a processor: one with no enabled method is enabled. */
  enabled(options: Parameters<NonNullable<LogRecordProcessor["enabled"]>>[0]): boolean {
    return this.inner.enabled === undefined || this.inner.enabled(options);
  }

  forceFlush(): Promise<void> {
    return this.flushes.run();
  }

  /** Waits for the flush under way, and the follow-up callers wait for, then shuts the processor down. */
  async shutdown(): Promise<void> {
    await this.flushes.idle();
    await this.inner.shutdown();
  }
}
