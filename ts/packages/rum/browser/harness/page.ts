/** Page helpers for the RUM specs. Runs on Node inside Playwright. */
import type { Page } from "@playwright/test";
import type { SinkRequest } from "../../../web/browser/harness/sink.ts";

/** What window.__rumStart takes. */
export interface FixtureOptions {
  readonly endpoint: string;
  readonly consent?: "pending" | "granted";
  readonly sessionSampleRate?: number;
  /** Collector factory names to install, such as ["views", "actions"]. R3b onward. */
  readonly collectors?: readonly string[];
  readonly queryAllowList?: readonly string[];
  readonly clientToken?: string;
}

/** Opens /page/rum-<name> and runs its __rumStart with opts. */
export async function startRum(page: Page, name: string, opts: FixtureOptions): Promise<void> {
  await page.goto(`/page/rum-${name}`);
  await rerunRum(page, opts);
}

/** Runs __rumStart again on the page already open, after a reload. */
export async function rerunRum(page: Page, opts: FixtureOptions): Promise<void> {
  await page.waitForFunction(() => "__rumStart" in globalThis);
  await page.evaluate(
    (o) => (globalThis as unknown as { __rumStart(o: unknown): Promise<void> }).__rumStart(o),
    opts,
  );
}

interface OtlpValue {
  readonly stringValue?: string;
  readonly intValue?: string | number;
  readonly doubleValue?: number;
  readonly boolValue?: boolean;
  readonly arrayValue?: { readonly values?: readonly OtlpValue[] };
  readonly kvlistValue?: { readonly values?: readonly OtlpAttribute[] };
}
interface OtlpAttribute {
  readonly key: string;
  readonly value: OtlpValue;
}

function value(v: OtlpValue): unknown {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue !== undefined) return (v.arrayValue.values ?? []).map(value);
  if (v.kvlistValue !== undefined) return attributes(v.kvlistValue.values);
  return undefined;
}

function attributes(list: readonly OtlpAttribute[] | undefined): Record<string, unknown> {
  return Object.fromEntries((list ?? []).map((a) => [a.key, value(a.value)]));
}

/** One log record the sink received. */
export interface SinkLog {
  readonly eventName?: string;
  readonly attributes: Record<string, unknown>;
  /** The record's body, with a map body as a plain object. */
  readonly body?: unknown;
}

/** Every log record the sink received, flattened, with attributes as a plain object. */
export function logRecords(requests: readonly SinkRequest[]): SinkLog[] {
  const out: SinkLog[] = [];
  for (const r of requests) {
    if (r.signal !== "logs") continue;
    const body = r.body as {
      resourceLogs?: {
        scopeLogs?: {
          logRecords?: { eventName?: string; attributes?: OtlpAttribute[]; body?: OtlpValue }[];
        }[];
      }[];
    };
    for (const rl of body.resourceLogs ?? []) {
      for (const sl of rl.scopeLogs ?? []) {
        for (const lr of sl.logRecords ?? []) {
          const attrs = attributes(lr.attributes);
          const name = lr.eventName ?? attrs["event.name"];
          out.push({
            ...(typeof name === "string" ? { eventName: name } : {}),
            attributes: attrs,
            ...(lr.body === undefined ? {} : { body: value(lr.body) }),
          });
        }
      }
    }
  }
  return out;
}

/** One span the sink received. */
export interface SinkSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly attributes: Record<string, unknown>;
  readonly links: { traceId: string; spanId: string }[];
  readonly events: { name: string; attributes: Record<string, unknown>; time: number }[];
  /** Epoch milliseconds. */
  readonly start: number;
  readonly end: number;
}

/** Every span the sink received, flattened. */
export function spans(requests: readonly SinkRequest[]): SinkSpan[] {
  const out: SinkSpan[] = [];
  for (const r of requests) {
    if (r.signal !== "traces") continue;
    const body = r.body as {
      resourceSpans?: {
        scopeSpans?: {
          spans?: {
            name: string;
            traceId: string;
            spanId: string;
            parentSpanId?: string;
            attributes?: OtlpAttribute[];
            links?: { traceId: string; spanId: string }[];
            events?: { name: string; attributes?: OtlpAttribute[]; timeUnixNano?: string | number }[];
            startTimeUnixNano?: string | number;
            endTimeUnixNano?: string | number;
          }[];
        }[];
      }[];
    };
    for (const rs of body.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) {
        for (const s of ss.spans ?? []) {
          out.push({
            name: s.name,
            traceId: s.traceId,
            spanId: s.spanId,
            ...(s.parentSpanId === undefined || s.parentSpanId === ""
              ? {}
              : { parentSpanId: s.parentSpanId }),
            attributes: attributes(s.attributes),
            links: (s.links ?? []).map((l) => ({ traceId: l.traceId, spanId: l.spanId })),
            events: (s.events ?? []).map((e) => ({
              name: e.name,
              attributes: attributes(e.attributes),
              time: Number(BigInt(e.timeUnixNano ?? 0) / 1_000_000n),
            })),
            start: Number(BigInt(s.startTimeUnixNano ?? 0) / 1_000_000n),
            end: Number(BigInt(s.endTimeUnixNano ?? 0) / 1_000_000n),
          });
        }
      }
    }
  }
  return out;
}
