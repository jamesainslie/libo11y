/**
 * WP4. What the instrumentation fixtures share: core's setupWith over testPlatform() with an
 * in-page InMemorySpanExporter, a page-local consent, and spans as JSON for the specs. Built
 * without the web platform, transport or consent controller, so the instrumentation specs run
 * before those work packages land. Bundled as a page of its own too, which does nothing.
 */
import { setupWith, type Telemetry } from "@libo11y/core";
import { hrTimeToMilliseconds } from "@opentelemetry/core";
import { InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import type { Consent, ConsentState } from "../../src/contracts/consent.ts";
import { testPlatform } from "../../src/test-support/index.ts";

/** A span as the specs read it; times in epoch milliseconds. */
export interface SpanJson {
  readonly name: string;
  readonly kind: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly startMs: number;
  readonly endMs: number;
  readonly attributes: Record<string, unknown>;
  readonly events: readonly { readonly name: string; readonly ms: number }[];
}

export function spanJson(s: ReadableSpan): SpanJson {
  return {
    name: s.name,
    kind: s.kind,
    traceId: s.spanContext().traceId,
    spanId: s.spanContext().spanId,
    parentSpanId: s.parentSpanContext?.spanId,
    startMs: hrTimeToMilliseconds(s.startTime),
    endMs: hrTimeToMilliseconds(s.endTime),
    attributes: { ...s.attributes },
    events: s.events.map((e) => ({ name: e.name, ms: hrTimeToMilliseconds(e.time) })),
  };
}

/** A minimal Consent: grant and revoke change the state and notify subscribers. */
function pageConsent(initial: ConsentState): Consent {
  let state = initial;
  const listeners = new Set<(s: ConsentState) => void>();
  const set = (next: ConsentState): void => {
    if (next === state) return;
    state = next;
    for (const l of [...listeners]) l(next);
  };
  return {
    state: () => state,
    grant: () => {
      set("granted");
      return state;
    },
    revoke: async () => set("denied"),
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

/** The fixture's telemetry (a WebTelemetry in shape), its exporter and its consent. */
export interface FixtureTelemetry {
  readonly telemetry: Telemetry & { readonly consent: Consent };
  readonly exporter: InMemorySpanExporter;
  readonly consent: Consent;
}

/** Sets up core telemetry with the consent the page's ?consent= names (default granted). */
export async function startTelemetry(): Promise<FixtureTelemetry> {
  const initial = (new URLSearchParams(location.search).get("consent") ?? "granted") as ConsentState;
  const exporter = new InMemorySpanExporter();
  const consent = pageConsent(initial);
  const handle = await setupWith(
    {
      serviceName: "wp4-fixture",
      environment: "test",
      startupSummary: false,
      console: false,
      spanProcessor: new SimpleSpanProcessor({ exporter }),
    },
    testPlatform(),
  );
  const telemetry = Object.assign(handle, { consent });
  return { telemetry, exporter, consent };
}
