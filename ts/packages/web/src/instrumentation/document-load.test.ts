/**
 * The documentLoad span: the pure builder over a fake navigation entry, and recordDocumentLoad's
 * waiting (load, consent, hide, abort, once per page) over an injected fake page environment, so
 * no global is touched.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Telemetry } from "@libo11y/core";
import { createRecorder, type Recorder } from "@libo11y/test";
import { type HrTime, SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { Consent, ConsentState } from "../contracts/consent.ts";
import {
  DOCUMENT_FETCH_SPAN,
  DOCUMENT_LOAD_SPAN,
  type DocumentLoadEnv,
  type NavigationTimingLike,
  recordDocumentLoadWith,
  recordNavigationSpans,
} from "./document-load.ts";
import { SCOPE } from "./http-common.ts";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";
/** A whole-second time origin, so expected times are exact. */
const ORIGIN = 1_700_000_000_000;

function entry(overrides: Partial<NavigationTimingLike> = {}): NavigationTimingLike {
  return {
    name: "https://app.example.com/shop/cart?session=secret#top",
    startTime: 0,
    fetchStart: 2,
    domainLookupStart: 3,
    domainLookupEnd: 4,
    connectStart: 5,
    secureConnectionStart: 6,
    connectEnd: 7,
    requestStart: 8,
    responseStart: 20,
    responseEnd: 25,
    unloadEventStart: 0,
    unloadEventEnd: 0,
    domInteractive: 40,
    domContentLoadedEventStart: 41,
    domContentLoadedEventEnd: 42,
    domComplete: 60,
    loadEventStart: 61,
    loadEventEnd: 62,
    responseStatus: 200,
    serverTiming: [],
    ...overrides,
  };
}

/** Milliseconds since ORIGIN of an HrTime. */
function sinceOrigin(t: HrTime): number {
  return (t[0] - ORIGIN / 1000) * 1000 + t[1] / 1e6;
}

function byName(rec: Recorder, name: string): ReadableSpan {
  const span = rec.spans().find((s) => s.name === name);
  assert.ok(
    span,
    `no ${name} span among ${rec
      .spans()
      .map((s) => s.name)
      .join(", ")}`,
  );
  return span;
}

async function withRec(fn: (rec: Recorder) => Promise<void> | void): Promise<void> {
  const rec = await createRecorder({ serviceName: "web-docload-test" });
  try {
    await fn(rec);
  } finally {
    await rec.shutdown();
  }
}

test("documentLoad spans startTime to loadEventEnd, documentFetch fetchStart to responseEnd, as its child", async () => {
  await withRec((rec) => {
    recordNavigationSpans(rec.telemetry.tracerProvider.getTracer(SCOPE), entry(), ORIGIN);
    const load = byName(rec, DOCUMENT_LOAD_SPAN);
    const fetchSpan = byName(rec, DOCUMENT_FETCH_SPAN);
    assert.equal(load.kind, SpanKind.INTERNAL);
    assert.equal(fetchSpan.kind, SpanKind.CLIENT);
    assert.equal(sinceOrigin(load.startTime), 0);
    assert.equal(sinceOrigin(load.endTime), 62);
    assert.equal(sinceOrigin(fetchSpan.startTime), 2);
    assert.equal(sinceOrigin(fetchSpan.endTime), 25);
    assert.equal(load.parentSpanContext, undefined, "no Server-Timing: a root span");
    assert.equal(fetchSpan.parentSpanContext?.spanId, load.spanContext().spanId);
    assert.equal(fetchSpan.spanContext().traceId, load.spanContext().traceId);
  });
});

test("the attributes are the document's url.path and url.scheme, never the query or fragment, and the status", async () => {
  await withRec((rec) => {
    recordNavigationSpans(rec.telemetry.tracerProvider.getTracer(SCOPE), entry(), ORIGIN);
    const load = byName(rec, DOCUMENT_LOAD_SPAN);
    const fetchSpan = byName(rec, DOCUMENT_FETCH_SPAN);
    assert.deepEqual(load.attributes, { "url.path": "/shop/cart", "url.scheme": "https" });
    assert.deepEqual(fetchSpan.attributes, {
      "url.path": "/shop/cart",
      "url.scheme": "https",
      "http.response.status_code": 200,
    });
    for (const span of [load, fetchSpan]) {
      assert.ok(!JSON.stringify(span.attributes).includes("secret"));
    }
  });
});

test("a status the browser does not expose is left out", async () => {
  await withRec((rec) => {
    const tracer = rec.telemetry.tracerProvider.getTracer(SCOPE);
    const { responseStatus: _, ...withoutStatus } = entry();
    recordNavigationSpans(tracer, withoutStatus, ORIGIN);
    recordNavigationSpans(tracer, entry({ responseStatus: 0 }), ORIGIN);
    const fetches = rec.spans().filter((s) => s.name === DOCUMENT_FETCH_SPAN);
    assert.equal(fetches.length, 2);
    assert.ok(fetches.every((s) => s.attributes["http.response.status_code"] === undefined));
  });
});

test("the navigation timing marks are span events at their times; unset marks are skipped", async () => {
  await withRec((rec) => {
    recordNavigationSpans(rec.telemetry.tracerProvider.getTracer(SCOPE), entry(), ORIGIN);
    const events = (s: ReadableSpan) => s.events.map((e) => [e.name, sinceOrigin(e.time)]);
    assert.deepEqual(events(byName(rec, DOCUMENT_FETCH_SPAN)), [
      ["fetchStart", 2],
      ["domainLookupStart", 3],
      ["domainLookupEnd", 4],
      ["connectStart", 5],
      ["secureConnectionStart", 6],
      ["connectEnd", 7],
      ["requestStart", 8],
      ["responseStart", 20],
      ["responseEnd", 25],
    ]);
    assert.deepEqual(events(byName(rec, DOCUMENT_LOAD_SPAN)), [
      ["fetchStart", 2],
      ["domInteractive", 40],
      ["domContentLoadedEventStart", 41],
      ["domContentLoadedEventEnd", 42],
      ["domComplete", 60],
      ["loadEventStart", 61],
      ["loadEventEnd", 62],
    ]);
  });
});

test("a valid Server-Timing traceparent is the documentLoad span's remote parent", async () => {
  await withRec((rec) => {
    recordNavigationSpans(
      rec.telemetry.tracerProvider.getTracer(SCOPE),
      entry({
        serverTiming: [
          { name: "db", description: "x" },
          { name: "traceparent", description: `00-${TRACE}-${SPAN}-01` },
        ],
      }),
      ORIGIN,
    );
    const load = byName(rec, DOCUMENT_LOAD_SPAN);
    assert.equal(load.spanContext().traceId, TRACE);
    assert.equal(load.parentSpanContext?.spanId, SPAN);
    assert.equal(load.parentSpanContext?.isRemote, true);
    assert.equal(byName(rec, DOCUMENT_FETCH_SPAN).spanContext().traceId, TRACE);
  });
});

test("an invalid Server-Timing traceparent is ignored", async () => {
  await withRec((rec) => {
    recordNavigationSpans(
      rec.telemetry.tracerProvider.getTracer(SCOPE),
      entry({ serverTiming: [{ name: "traceparent", description: `00-${"0".repeat(32)}-${SPAN}-01` }] }),
      ORIGIN,
    );
    const load = byName(rec, DOCUMENT_LOAD_SPAN);
    assert.equal(load.parentSpanContext, undefined);
    assert.notEqual(load.spanContext().traceId, TRACE);
  });
});

// recordDocumentLoadWith over a fake page.

interface FakePage extends DocumentLoadEnv {
  readonly document: EventTarget & { readyState: string; visibilityState: string };
  readonly window: EventTarget;
  /** Runs the queued setTimeout callbacks. */
  tick(): void;
  /** Fires load on the window, as the browser does once readyState is complete. */
  load(): void;
  hide(): void;
}

/** A fake page; nav null means the browser has no navigation entry. */
function fakePage(nav: NavigationTimingLike | null = entry(), readyState = "complete"): FakePage {
  const document = Object.assign(new EventTarget(), { readyState, visibilityState: "visible" });
  const window = new EventTarget();
  const timers: (() => void)[] = [];
  return {
    document,
    window,
    performance: {
      timeOrigin: ORIGIN,
      getEntriesByType: (type: string) => (type === "navigation" && nav !== null ? [nav] : []),
    },
    setTimeout: (fn: () => void) => {
      timers.push(fn);
    },
    tick() {
      for (const fn of timers.splice(0)) fn();
    },
    load() {
      document.readyState = "complete";
      window.dispatchEvent(new Event("load"));
    },
    hide() {
      document.visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

function settableConsent(initial: ConsentState): Consent & { set(s: ConsentState): void } {
  let state = initial;
  const listeners = new Set<(s: ConsentState) => void>();
  const set = (s: ConsentState) => {
    if (s === state) return;
    state = s;
    for (const l of [...listeners]) l(s);
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
      return () => listeners.delete(l);
    },
    set,
  };
}

function withConsent(telemetry: Telemetry, consent: Consent): Telemetry {
  return Object.assign(Object.create(telemetry) as object, { consent }) as unknown as Telemetry;
}

/** Lets promise callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test("without a document or a navigation entry recordDocumentLoad is a no-op", async () => {
  await withRec(async (rec) => {
    await recordDocumentLoadWith(
      { telemetry: rec.telemetry },
      { document: undefined, window: undefined, performance: undefined },
    );
    const page = fakePage(null);
    const done = recordDocumentLoadWith({ telemetry: rec.telemetry }, page);
    page.tick();
    await done;
    assert.equal(rec.spans().length, 0);
  });
});

test("it waits for load and one task after it, then records", async () => {
  await withRec(async (rec) => {
    const page = fakePage(entry(), "interactive");
    let resolved = false;
    const done = recordDocumentLoadWith({ telemetry: rec.telemetry }, page).then(() => {
      resolved = true;
    });
    page.tick();
    await settle();
    assert.equal(rec.spans().length, 0, "nothing before load");
    page.load();
    await settle();
    assert.equal(rec.spans().length, 0, "nothing until the task after load");
    page.tick();
    await done;
    assert.equal(resolved, true);
    assert.deepEqual(
      rec
        .spans()
        .map((s) => s.name)
        .sort(),
      [DOCUMENT_FETCH_SPAN, DOCUMENT_LOAD_SPAN],
    );
  });
});

test("with consent pending it waits for the grant and records the historical times", async () => {
  await withRec(async (rec) => {
    const consent = settableConsent("pending");
    const page = fakePage();
    const done = recordDocumentLoadWith({ telemetry: withConsent(rec.telemetry, consent) }, page);
    page.tick();
    await settle();
    assert.equal(rec.spans().length, 0);
    consent.set("denied");
    await settle();
    assert.equal(rec.spans().length, 0, "denied is not a grant");
    consent.grant();
    await done;
    const load = byName(rec, DOCUMENT_LOAD_SPAN);
    assert.equal(sinceOrigin(load.startTime), 0);
    assert.equal(sinceOrigin(load.endTime), 62);
  });
});

test("a page hidden before the grant records nothing", async () => {
  await withRec(async (rec) => {
    const consent = settableConsent("pending");
    const page = fakePage();
    const done = recordDocumentLoadWith({ telemetry: withConsent(rec.telemetry, consent) }, page);
    page.tick();
    await settle();
    page.hide();
    await done;
    consent.grant();
    await settle();
    assert.equal(rec.spans().length, 0);
  });
});

test("pagehide before the grant also abandons it", async () => {
  await withRec(async (rec) => {
    const consent = settableConsent("pending");
    const page = fakePage();
    const done = recordDocumentLoadWith({ telemetry: withConsent(rec.telemetry, consent) }, page);
    page.tick();
    await settle();
    page.window.dispatchEvent(new Event("pagehide"));
    await done;
    consent.grant();
    await settle();
    assert.equal(rec.spans().length, 0);
  });
});

test("an abort abandons a span not yet recorded, before or after load", async () => {
  await withRec(async (rec) => {
    const consent = settableConsent("pending");
    const telemetry = withConsent(rec.telemetry, consent);
    const before = new AbortController();
    before.abort();
    await recordDocumentLoadWith({ telemetry, signal: before.signal }, fakePage());

    const loading = fakePage(entry(), "loading");
    const duringLoad = new AbortController();
    const one = recordDocumentLoadWith({ telemetry, signal: duringLoad.signal }, loading);
    duringLoad.abort();
    await one;

    const waiting = fakePage();
    const duringConsent = new AbortController();
    const two = recordDocumentLoadWith({ telemetry, signal: duringConsent.signal }, waiting);
    waiting.tick();
    await settle();
    duringConsent.abort();
    await two;
    consent.grant();
    await settle();
    assert.equal(rec.spans().length, 0);
  });
});

test("it records once per page", async () => {
  await withRec(async (rec) => {
    const page = fakePage();
    const one = recordDocumentLoadWith({ telemetry: rec.telemetry }, page);
    const two = recordDocumentLoadWith({ telemetry: rec.telemetry }, page);
    page.tick();
    await Promise.all([one, two]);
    const three = recordDocumentLoadWith({ telemetry: rec.telemetry }, page);
    page.tick();
    await three;
    assert.equal(rec.spans().filter((s) => s.name === DOCUMENT_LOAD_SPAN).length, 1);
  });
});
