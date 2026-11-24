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
