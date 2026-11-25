/**
 * WP4. recordDocumentLoad in a real page. Query: ?consent=pending|granted (default granted), and
 * the server's ?serverTiming=<traceparent>. Exposes window.__docload once set up.
 */
import { recordDocumentLoad } from "../../src/instrumentation/document-load.ts";
import { type SpanJson, spanJson, startTelemetry } from "./instrumentation-common.ts";

const { telemetry, exporter, consent } = await startTelemetry();
let finished = false;
const done = recordDocumentLoad({ telemetry }).then(() => {
  finished = true;
});
let grantedAt: number | undefined;

const api = {
  /** Resolves when recordDocumentLoad has resolved. */
  done: () => done.then(() => true),
  finished: () => finished,
  /** Grants consent and returns when, in epoch milliseconds. */
  grant: (): number => {
    grantedAt = performance.timeOrigin + performance.now();
    consent.grant();
    return grantedAt;
  },
  grantedAt: () => grantedAt,
  loaded: () => document.readyState === "complete",
  /** The finished spans, after a flush, since the simple processor exports in a microtask. */
  spans: async (): Promise<SpanJson[]> => {
    await telemetry.forceFlush();
    return exporter.getFinishedSpans().map(spanJson);
  },
};
(globalThis as { __docload?: typeof api }).__docload = api;
