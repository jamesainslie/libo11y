/** The sessions an OTLP JSON batch holds records of, so the retention flush can check each batch. */
import type { OtlpBatch } from "@libo11y/web/internal";
import { ATTR_SESSION_ID } from "../attrs.ts";

interface Attr {
  readonly key?: unknown;
  readonly value?: { readonly stringValue?: unknown };
}
interface Item {
  readonly attributes?: readonly Attr[];
}

function collect(items: readonly Item[] | undefined, into: Set<string>): void {
  for (const item of items ?? []) {
    for (const a of item.attributes ?? []) {
      if (a.key === ATTR_SESSION_ID && typeof a.value?.stringValue === "string")
        into.add(a.value.stringValue);
    }
  }
}

/** Every session.id in batch's records, or undefined when the body is not readable OTLP JSON. */
export function sessionsIn(batch: OtlpBatch): ReadonlySet<string> | undefined {
  let body: unknown;
  try {
    body = JSON.parse(batch.body);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const ids = new Set<string>();
  const b = body as {
    resourceSpans?: { scopeSpans?: { spans?: Item[] }[] }[];
    resourceLogs?: { scopeLogs?: { logRecords?: Item[] }[] }[];
  };
  for (const rs of b.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) collect(ss.spans, ids);
  for (const rl of b.resourceLogs ?? []) for (const sl of rl.scopeLogs ?? []) collect(sl.logRecords, ids);
  return ids;
}
