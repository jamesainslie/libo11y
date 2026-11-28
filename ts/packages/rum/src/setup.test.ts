import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { O11yError } from "@libo11y/core";
import {
  createMemoryQueue,
  defaultSetupDeps,
  type HttpTransportOptions,
  type PersistentQueue,
  type SetupDeps,
} from "@libo11y/web/internal";
import { createFakeTransport, type FakeTransport } from "../../web/src/test-support/index.ts";
import type { RumSetupOptions, RumTelemetry } from "./options.ts";
import { RETENTION_QUEUE_DEFAULTS } from "./retention/buffer.ts";
import { sessionsIn } from "./retention/sessions.ts";
import { localStorageSessionStore, SESSION_STORAGE_KEY } from "./session/local-store.ts";
import { type RumDeps, runtimeOf, setupRumWith } from "./setup.ts";
import { createChannelHub, createFakeStorage } from "./test-support/fake-storage.ts";

class FakeDocument extends EventTarget {
  visibilityState: "visible" | "hidden" = "visible";
  hide(): void {
    this.visibilityState = "hidden";
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

interface Harness {
  readonly transport: FakeTransport;
  readonly storage: ReturnType<typeof createFakeStorage>;
  readonly document: FakeDocument;
  readonly transportOptions: HttpTransportOptions[];
  readonly deps: RumDeps;
}

interface Shared {
  readonly storage?: ReturnType<typeof createFakeStorage>;
  readonly hub?: ReturnType<typeof createChannelHub>;
  readonly now?: () => number;
  readonly retentionQueue?: PersistentQueue;
}

function harness(shared: Shared = {}): Harness {
  const transport = createFakeTransport();
  const storage = shared.storage ?? createFakeStorage();
  const hub = shared.hub ?? createChannelHub();
  const document = new FakeDocument();
  const window = new EventTarget();
  const transportOptions: HttpTransportOptions[] = [];
  const base = defaultSetupDeps();
  const web: SetupDeps = {
    ...base,
    openQueue: async (o) => createMemoryQueue(o),
    createHttpTransport: (o) => {
      transportOptions.push(o);
      return transport;
    },
    installFetchInstrumentation: () => () => {},
    installXhrInstrumentation: () => () => {},
    recordDocumentLoad: async () => {},
    document,
    window,
  };
  return {
    transport,
    storage,
    document,
    transportOptions,
    deps: {
      web,
      openRetentionQueue: async (o) => shared.retentionQueue ?? createMemoryQueue(o),
      sessionStore: () => localStorageSessionStore({ storage, channel: hub.channel() }),
      now: shared.now ?? Date.now,
      perfNow: () => performance.now(),
      location: () => "https://app.test/documents/7",
      prerendered: () => false,
      connection: () => undefined,
      document,
      window,
    },
  };
}

const OPTS: RumSetupOptions = {
  serviceName: "rum-test",
  serviceVersion: "1.0.0",
  environment: "test",
  endpoint: "https://gateway.test/_o11y",
  runtimeMetrics: false,
  startupSummary: false,
  transport: { compression: "none" },
};

let open: RumTelemetry | undefined;
afterEach(async () => {
  await open?.shutdown();
  open = undefined;
});

type OtlpAttr = { key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number } };

function logRecords(t: FakeTransport): Record<string, unknown>[] {
  return t.requests
    .filter((r) => r.signal === "logs")
    .flatMap((r) => {
      const body = JSON.parse(r.body) as {
        resourceLogs: { scopeLogs: { logRecords: { attributes: OtlpAttr[] }[] }[] }[];
      };
      return body.resourceLogs.flatMap((rl) =>
        rl.scopeLogs.flatMap((sl) =>
          sl.logRecords.map((lr) =>
            Object.fromEntries(
              lr.attributes.map((a) => [
                a.key,
                a.value.stringValue ?? a.value.doubleValue ?? Number(a.value.intValue),
              ]),
            ),
          ),
        ),
      );
    });
}

function sentEvents(t: FakeTransport): unknown[] {
  return logRecords(t).map((a) => a["event.name"]);
}

function spanNames(t: FakeTransport): string[] {
  return t.requests
    .filter((r) => r.signal === "traces")
    .flatMap((r) => {
      const body = JSON.parse(r.body) as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] };
      return body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans.map((s) => s.name)));
    });
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("pending consent records, stores and sends nothing", async () => {
  const h = harness();
  open = await setupRumWith(OPTS, h.deps);
  assert.equal(open.rum.sessionId(), undefined);
  open.tracerProvider.getTracer("app").startSpan("work").end();
  h.document.hide();
  await new Promise((r) => setTimeout(r, 0));
  await open.forceFlush();
  assert.deepEqual(h.transport.requests, []);
  assert.equal(h.storage.items.size, 0);
});

test("an unkept session sends only its view summary on hide", async () => {
  const h = harness();
  open = await setupRumWith(
    { ...OPTS, consent: { initial: "granted" }, rum: { sessionSampleRate: 0 } },
    h.deps,
  );
  const id = open.rum.sessionId();
  assert.ok(id);
  open.tracerProvider.getTracer("app").startSpan("work").end();
  h.document.hide();
  await new Promise((r) => setTimeout(r, 0));
  await open.forceFlush();
  assert.deepEqual(sentEvents(h.transport), ["o11y.rum.view.summary"]);
  assert.deepEqual(spanNames(h.transport), []);
  const [summary] = logRecords(h.transport);
  assert.equal(summary?.["session.id"], id);
  assert.equal(summary?.["o11y.rum.view.name"], "/documents/$id");
  assert.equal(summary?.["o11y.rum.view.kind"], "initial");
  assert.ok(h.storage.items.has(SESSION_STORAGE_KEY));
});

test("retaining the session sends the buffered detail", async () => {
  const h = harness();
  open = await setupRumWith(
    { ...OPTS, consent: { initial: "granted" }, rum: { sessionSampleRate: 0 } },
    h.deps,
  );
  open.tracerProvider.getTracer("app").startSpan("work").end();
  await open.forceFlush();
  assert.deepEqual(sentEvents(h.transport), []);
  assert.deepEqual(spanNames(h.transport), []);
  runtimeOf(open)?.session.retain("error");
  await until(
    () =>
      sentEvents(h.transport).includes("o11y.rum.session.start") && spanNames(h.transport).includes("work"),
    "the buffered session.start and span",
  );
});

test("a head-sampled session sends session.start and its spans at once", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
  open.tracerProvider.getTracer("app").startSpan("work").end();
  await open.forceFlush();
  assert.deepEqual(sentEvents(h.transport), ["o11y.rum.session.start"]);
  assert.deepEqual(spanNames(h.transport), ["work"]);
});

test("granting consent later starts the session", async () => {
  const h = harness();
  open = await setupRumWith(OPTS, h.deps);
  open.consent.grant();
  await until(() => open?.rum.sessionId() !== undefined, "the session");
  assert.equal(runtimeOf(open)?.views.current()?.kind, "initial");
});

test("revoking consent removes the session", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
  await open.consent.revoke();
  assert.equal(h.storage.items.has(SESSION_STORAGE_KEY), false);
  assert.equal(open.rum.sessionId(), undefined);
  assert.equal(runtimeOf(open)?.views.current(), undefined);
});

test("collectors start on grant and stop on revoke", async () => {
  const h = harness();
  const calls: string[] = [];
  open = await setupRumWith(
    {
      ...OPTS,
      rum: {
        collectors: [
          {
            name: "errors",
            start: (rt) => {
              calls.push(`start ${rt.session.current()?.id === undefined ? "no session" : "session"}`);
              return () => calls.push("stop");
            },
          },
        ],
      },
    },
    h.deps,
  );
  assert.deepEqual(calls, []);
  open.consent.grant();
  await until(() => calls.length === 1, "the collector start");
  await open.consent.revoke();
  assert.deepEqual(calls, ["start session", "stop"]);
});

test("identify refuses an email address", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
  assert.throws(
    () => open?.rum.identify("someone@example.com"),
    (e: unknown) => e instanceof O11yError && e.code === "INVALID_OPTION",
  );
  open.rum.identify("u-1");
});

test("the transport posts with the wire parameters", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, rum: { clientToken: "pub-1" } }, h.deps);
  const o = h.transportOptions[0];
  assert.ok(o?.fetch !== undefined);
  assert.ok("sendBeacon" in o);
});

test("hermetic mode with nothing injected sends nothing, as in @libo11y/web", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, hermetic: true, consent: { initial: "granted" } }, h.deps);
  open.tracerProvider.getTracer("app").startSpan("work").end();
  await open.forceFlush();
  assert.deepEqual(h.transport.requests, []);
});

test("spans export even when no other signal needs the platform", async () => {
  const h = harness();
  open = await setupRumWith(
    {
      ...OPTS,
      consent: { initial: "granted" },
      env: { OTEL_METRICS_EXPORTER: "none", OTEL_LOGS_EXPORTER: "none" },
    },
    h.deps,
  );
  open.tracerProvider.getTracer("app").startSpan("work").end();
  await open.forceFlush();
  assert.deepEqual(spanNames(h.transport), ["work"]);
});

test("an injected span exporter receives the kept spans in hermetic mode", async () => {
  const h = harness();
  const { InMemorySpanExporter } = await import("@opentelemetry/sdk-trace");
  const exporter = new InMemorySpanExporter();
  open = await setupRumWith(
    { ...OPTS, hermetic: true, consent: { initial: "granted" }, spanExporter: exporter },
    h.deps,
  );
  open.tracerProvider.getTracer("app").startSpan("work").end();
  await open.forceFlush();
  assert.deepEqual(
    exporter.getFinishedSpans().map((s) => s.name),
    ["work"],
  );
  assert.equal(exporter.getFinishedSpans()[0]?.attributes["session.id"], open.rum.sessionId());
});

test("a grant right after a revoke leaves RUM running", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
  const revoked = open.consent.revoke();
  open.consent.grant();
  await revoked;
  await until(() => open?.rum.sessionId() !== undefined, "a session after the grant");
  // The page already loaded under the first grant, so the new session's view is soft (P14).
  assert.equal(runtimeOf(open)?.views.current()?.kind, "soft");
});

test("a revoke before any grant touches no storage", async () => {
  const h = harness();
  let opened = 0;
  open = await setupRumWith(OPTS, {
    ...h.deps,
    openRetentionQueue: async (o) => {
      opened++;
      return createMemoryQueue(o);
    },
  });
  h.storage.setItem(SESSION_STORAGE_KEY, "untouched");
  await open.consent.revoke();
  assert.equal(opened, 0);
  assert.equal(h.storage.items.get(SESSION_STORAGE_KEY), "untouched");
});

test("a failing retention queue never breaks revoke or shutdown", async () => {
  const h = harness();
  open = await setupRumWith(
    { ...OPTS, consent: { initial: "granted" }, rum: { sessionSampleRate: 0 } },
    { ...h.deps, openRetentionQueue: () => Promise.reject(new Error("no IndexedDB")) },
  );
  open.tracerProvider.getTracer("app").startSpan("work").end();
  await open.forceFlush();
  await open.consent.revoke();
  assert.equal(h.storage.items.has(SESSION_STORAGE_KEY), false);
});

test("a stored kept session sends what an earlier page left in the buffer", async () => {
  const h = harness();
  const queue = createMemoryQueue({});
  const now = Date.now();
  h.storage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      v: 1,
      id: "s-kept",
      startedAt: now,
      lastActivityAt: now,
      sampled: false,
      retained: "error",
    }),
  );
  await queue.put({ signal: "traces", body: tracesBody("left", "s-kept") });
  await queue.put({ signal: "traces", body: tracesBody("other", "s-unknown") });
  open = await setupRumWith(
    { ...OPTS, consent: { initial: "granted" } },
    { ...h.deps, openRetentionQueue: async () => queue },
  );
  assert.equal(open.rum.sessionId(), "s-kept");
  await until(() => spanNames(h.transport).includes("left"), "the leftover span");
  assert.equal(spanNames(h.transport).includes("other"), false);
  assert.equal((await queue.size()).entries, 0);
});

test("a failed setup removes RUM's listeners", async () => {
  const h = harness();
  const added: string[] = [];
  const removed: string[] = [];
  const win = new EventTarget();
  const spy = {
    addEventListener: (
      t: string,
      l: EventListenerOrEventListenerObject,
      o?: AddEventListenerOptions | boolean,
    ) => {
      added.push(t);
      win.addEventListener(t, l, o);
    },
    removeEventListener: (
      t: string,
      l: EventListenerOrEventListenerObject,
      o?: EventListenerOptions | boolean,
    ) => {
      removed.push(t);
      win.removeEventListener(t, l, o);
    },
    dispatchEvent: (e: Event) => win.dispatchEvent(e),
  };
  await assert.rejects(
    setupRumWith(OPTS, {
      ...h.deps,
      window: spy,
      web: {
        ...h.deps.web,
        window: spy,
        createExporterSet: () => {
          throw new Error("boom");
        },
      },
    }),
  );
  assert.deepEqual(added.sort(), removed.sort());
});

function tracesBody(name: string, sessionId: string): string {
  return JSON.stringify({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                name,
                traceId: "0af7651916cd43dd8448eb211c80319c",
                spanId: "b7ad6b7169203331",
                kind: 1,
                startTimeUnixNano: "1",
                endTimeUnixNano: "2",
                attributes: [{ key: "session.id", value: { stringValue: sessionId } }],
              },
            ],
          },
        ],
      },
    ],
  });
}

test("app Meter API metrics export with delta temporality, as the gateway requires", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
  open.meterProvider.getMeter("app").createCounter("app.clicks").add(2);
  open.meterProvider.getMeter("app").createHistogram("app.wait").record(1);
  await open.forceFlush();
  const temporalities = h.transport.requests
    .filter((r) => r.signal === "metrics")
    .flatMap((r) => {
      const body = JSON.parse(r.body) as {
        resourceMetrics: {
          scopeMetrics: {
            metrics: {
              name: string;
              sum?: { aggregationTemporality: number };
              histogram?: { aggregationTemporality: number };
            }[];
          }[];
        }[];
      };
      return body.resourceMetrics.flatMap((rm) =>
        rm.scopeMetrics.flatMap((sm) =>
          sm.metrics
            .filter((m) => m.name.startsWith("app."))
            .map((m) => (m.sum ?? m.histogram)?.aggregationTemporality),
        ),
      );
    });
  // OTLP AGGREGATION_TEMPORALITY_DELTA is 1, CUMULATIVE 2.
  assert.ok(temporalities.length >= 2);
  assert.deepEqual(new Set(temporalities), new Set([1]));
});

test("rum.addError retains an unkept session and sends the error with its breadcrumbs", async () => {
  const h = harness();
  open = await setupRumWith(
    { ...OPTS, consent: { initial: "granted" }, rum: { sessionSampleRate: 0 } },
    h.deps,
  );
  open.rum.addAction("Save");
  open.rum.addError(new Error("x"));
  await until(() => sentEvents(h.transport).includes("o11y.rum.error"), "the error");
  const err = logRecords(h.transport).find((r) => r["event.name"] === "o11y.rum.error");
  assert.equal(err?.["o11y.rum.error.source"], "custom");
  assert.equal(err?.["exception.message"], "x");
  const crumbs = String(err?.["o11y.rum.error.breadcrumbs"]).split("\n");
  assert.match(crumbs[0] ?? "", /^view \/documents\/\$id -\d+ms$/);
  assert.match(crumbs[1] ?? "", /^custom Save -\d+ms$/);
  assert.equal(runtimeOf(open)?.session.kept(), true);
});

test("rum.addError with a boundary source and component stack", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
  open.rum.addError("bad", { source: "boundary", componentStack: "\n  at Doc" });
  await open.forceFlush();
  const err = logRecords(h.transport).find((r) => r["event.name"] === "o11y.rum.error");
  assert.equal(err?.["o11y.rum.error.source"], "boundary");
  assert.equal(err?.["exception.stacktrace"], "\n\n  at Doc");
});

test("the Rum methods record nothing while consent is pending", async () => {
  const h = harness();
  open = await setupRumWith(OPTS, h.deps);
  open.rum.addError(new Error("x"));
  open.rum.addAction("Save");
  open.rum.startView({ name: "/x" });
  open.rum.setViewName("/y");
  open.rum.viewRendered();
  await open.forceFlush();
  assert.deepEqual(h.transport.requests, []);
  assert.equal(h.storage.items.size, 0);
});

test("rum.addAction records an instant action span", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
  open.rum.addAction("Save");
  await open.forceFlush();
  assert.ok(spanNames(h.transport).includes("action custom"));
});

test("startView, setViewName and viewRendered drive the view tracker", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
  const rt = runtimeOf(open);
  assert.ok(rt);
  const seen: string[] = [];
  rt.views.subscribe((e) => seen.push(`${e.type} ${e.view.name}`));
  const action = rt.tracer.startSpan("action click");
  rt.setActiveAction(action);
  let cause: string | undefined;
  rt.views.subscribe((e) => {
    if (e.type === "start") cause = e.cause?.spanId;
  });
  open.rum.startView({ name: "/docs/$docId" });
  open.rum.setViewName("/docs/$id");
  open.rum.viewRendered();
  open.rum.startView();
  assert.deepEqual(seen, [
    "end /documents/$id",
    "start /docs/$docId",
    "rename /docs/$id",
    "rendered /docs/$id",
    "end /docs/$id",
    "start /documents/$id",
  ]);
  assert.equal(cause, action.spanContext().spanId);
  assert.equal(rt.views.current()?.kind, "soft");
  action.end();
});

test("a span started while an action is open is its child", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
  const rt = runtimeOf(open);
  assert.ok(rt);
  const action = rt.tracer.startSpan("action click");
  rt.setActiveAction(action);
  const child = open.tracerProvider.getTracer("app").startSpan("GET");
  assert.equal(
    (child as unknown as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId,
    action.spanContext().spanId,
  );
  rt.setActiveAction(undefined);
  const root = open.tracerProvider.getTracer("app").startSpan("GET");
  assert.equal((root as unknown as { parentSpanContext?: unknown }).parentSpanContext, undefined);
  child.end();
  root.end();
  action.end();
});

test("revoking consent forgets the breadcrumbs and the open action", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
  const rt = runtimeOf(open);
  assert.ok(rt);
  open.rum.addAction("Save");
  rt.setActiveAction(rt.tracer.startSpan("action click"));
  assert.ok(rt.breadcrumbs().length > 0);
  await open.consent.revoke();
  assert.deepEqual(rt.breadcrumbs(), []);
  assert.equal(rt.activeAction(), undefined);
});

const IDLE = 900_000;

test("an unkept session that ends removes only its own records from the shared buffer", async () => {
  let now = 1_000_000;
  const retentionQueue = createMemoryQueue({
    ...RETENTION_QUEUE_DEFAULTS,
    maxAgeMillis: 10 * IDLE,
    now: () => now,
  });
  const other = JSON.stringify({
    resourceLogs: [
      {
        scopeLogs: [
          { logRecords: [{ attributes: [{ key: "session.id", value: { stringValue: "other" } }] }] },
        ],
      },
    ],
  });
  await retentionQueue.put({ signal: "logs", body: other });
  const h = harness({ now: () => now, retentionQueue });
  open = await setupRumWith(
    { ...OPTS, consent: { initial: "granted" }, rum: { sessionSampleRate: 0 } },
    h.deps,
  );
  const ended = open.rum.sessionId();
  assert.ok(ended);
  open.tracerProvider.getTracer("app").startSpan("work").end();
  await open.forceFlush();
  await new Promise((r) => setTimeout(r, 0));
  const held = async (): Promise<string[]> => {
    const entries = await retentionQueue.claim(now, 100, 0);
    return entries.flatMap((e) => [...(sessionsIn(e) ?? [])]).sort();
  };
  assert.ok((await held()).includes(ended), "the session's detail is buffered");
  now += IDLE;
  open.tracerProvider.getTracer("app").startSpan("after").end();
  runtimeOf(open)?.session.touch();
  assert.notEqual(open.rum.sessionId(), ended);
  const deadline = Date.now() + 2000;
  while ((await held()).includes(ended)) {
    if (Date.now() > deadline) assert.fail("the ended session's records were not removed");
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok((await held()).includes("other"), "another session's records stay");
});

test("two tabs that rotate a session at once emit one session.end for it", async () => {
  let now = 1_000_000;
  const storage = createFakeStorage();
  const hub = createChannelHub({ async: true });
  const a = harness({ storage, hub, now: () => now });
  const b = harness({ storage, hub, now: () => now });
  const tabA = await setupRumWith(
    { ...OPTS, consent: { initial: "granted" } },
    { ...a.deps, install: false },
  );
  const tabB = await setupRumWith(
    { ...OPTS, consent: { initial: "granted" } },
    { ...b.deps, install: false },
  );
  try {
    await new Promise((r) => setTimeout(r, 10));
    const first = tabA.rum.sessionId();
    assert.equal(tabB.rum.sessionId(), first, "the tabs share the session");
    now += IDLE;
    // Both tabs see the session expired before either hears of the other's rotation.
    runtimeOf(tabA)?.session.touch();
    runtimeOf(tabB)?.session.touch();
    await until(() => tabA.rum.sessionId() === tabB.rum.sessionId(), "the tabs to agree on a session");
    await new Promise((r) => setTimeout(r, 700));
    await Promise.all([tabA.forceFlush(), tabB.forceFlush()]);
    const ends = [...logRecords(a.transport), ...logRecords(b.transport)].filter(
      (r) => r["event.name"] === "o11y.rum.session.end",
    );
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.["session.id"], first);
  } finally {
    await tabA.shutdown();
    await tabB.shutdown();
  }
});

test("two tabs that rotate a session at once send session.start only for the winning session", async () => {
  let now = 1_000_000;
  const storage = createFakeStorage();
  const hub = createChannelHub({ async: true });
  const a = harness({ storage, hub, now: () => now });
  const b = harness({ storage, hub, now: () => now });
  const tabA = await setupRumWith(
    { ...OPTS, consent: { initial: "granted" } },
    { ...a.deps, install: false },
  );
  const tabB = await setupRumWith(
    { ...OPTS, consent: { initial: "granted" } },
    { ...b.deps, install: false },
  );
  try {
    await new Promise((r) => setTimeout(r, 10));
    const first = tabA.rum.sessionId();
    now += IDLE;
    runtimeOf(tabA)?.session.touch();
    runtimeOf(tabB)?.session.touch();
    await until(() => tabA.rum.sessionId() === tabB.rum.sessionId(), "the tabs to agree on a session");
    const winner = tabA.rum.sessionId();
    await new Promise((r) => setTimeout(r, 700));
    await Promise.all([tabA.forceFlush(), tabB.forceFlush()]);
    const starts = [...logRecords(a.transport), ...logRecords(b.transport)]
      .filter((r) => r["event.name"] === "o11y.rum.session.start" && r["session.id"] !== first)
      .map((r) => r["session.id"]);
    assert.deepEqual(starts, [winner]);
  } finally {
    await tabA.shutdown();
    await tabB.shutdown();
  }
});

test("a rotated session's start still goes out when the page hides before the election ends", async () => {
  let now = 1_000_000;
  const h = harness({ now: () => now });
  open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
  now += IDLE;
  runtimeOf(open)?.session.touch();
  const rotated = open.rum.sessionId();
  h.deps.window?.dispatchEvent(new Event("pagehide"));
  await open.forceFlush();
  const starts = logRecords(h.transport)
    .filter((r) => r["event.name"] === "o11y.rum.session.start")
    .map((r) => r["session.id"]);
  assert.ok(starts.includes(rotated), "the rotated session's start was sent on pagehide");
});

function logBodies(t: FakeTransport): unknown[] {
  return t.requests
    .filter((r) => r.signal === "logs")
    .flatMap((r) => {
      const body = JSON.parse(r.body) as {
        resourceLogs: { scopeLogs: { logRecords: { body?: unknown }[] }[] }[];
      };
      return body.resourceLogs.flatMap((rl) =>
        rl.scopeLogs.flatMap((sl) => sl.logRecords.map((lr) => lr.body)),
      );
    });
}

test("an event with a body goes out with that body, the event name and the session", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
  const rt = runtimeOf(open);
  assert.ok(rt);
  rt.emit("browser.web_vital", { "o11y.rum.element.selector": "#save" }, undefined, {
    name: "inp",
    value: 0.24,
    delta: 0.24,
    id: "v5-1",
  });
  await open.forceFlush();
  const i = logRecords(h.transport).findIndex((r) => r["event.name"] === "browser.web_vital");
  assert.ok(i >= 0, "the event was sent");
  const record = logRecords(h.transport)[i];
  assert.equal(record?.["session.id"], open.rum.sessionId());
  assert.equal(record?.["o11y.rum.view.id"], rt.views.current()?.id);
  assert.equal(record?.["o11y.rum.element.selector"], "#save");
  assert.deepEqual(logBodies(h.transport)[i], {
    kvlistValue: {
      values: [
        { key: "name", value: { stringValue: "inp" } },
        { key: "value", value: { doubleValue: 0.24 } },
        { key: "delta", value: { doubleValue: 0.24 } },
        { key: "id", value: { stringValue: "v5-1" } },
      ],
    },
  });
});

test("an event with a body is buffered for an unkept session and dropped without consent", async () => {
  const h = harness();
  open = await setupRumWith(
    { ...OPTS, consent: { initial: "granted" }, rum: { sessionSampleRate: 0 } },
    h.deps,
  );
  const rt = runtimeOf(open);
  assert.ok(rt);
  rt.emit("browser.web_vital", {}, undefined, { name: "lcp", value: 1, delta: 1, id: "a" });
  await open.forceFlush();
  assert.equal(sentEvents(h.transport).includes("browser.web_vital"), false);
  await open.consent.revoke();
  rt.emit("browser.web_vital", {}, undefined, { name: "lcp", value: 1, delta: 1, id: "b" });
  open.consent.grant();
  await until(() => open?.rum.sessionId() !== undefined, "the session");
  runtimeOf(open)?.session.retain("error");
  await new Promise((r) => setTimeout(r, 50));
  await open.forceFlush();
  assert.equal(sentEvents(h.transport).includes("browser.web_vital"), false);
});

test("the runtime ignores the OTLP endpoints and the app's ignoreUrls", async () => {
  const h = harness();
  open = await setupRumWith(
    {
      ...OPTS,
      consent: { initial: "granted" },
      instrumentations: { ignoreUrls: ["https://ads.test/", /\/health$/] },
    },
    h.deps,
  );
  const rt = runtimeOf(open);
  assert.ok(rt);
  assert.equal(rt.ignored("https://gateway.test/_o11y/v1/traces"), true);
  assert.equal(rt.ignored("https://gateway.test/_o11y/v1/logs"), true);
  assert.equal(rt.ignored("https://ads.test/pixel.gif"), true);
  assert.equal(rt.ignored("https://app.test/health"), true);
  assert.equal(rt.ignored("https://app.test/main.js"), false);
  assert.equal(rt.ignored("not a url"), false);
});

/** The event names of each logs request, in order. */
function logRequests(t: FakeTransport): unknown[][] {
  return t.requests
    .filter((r) => r.signal === "logs")
    .map((r) => logRecords({ ...t, requests: [r] } as FakeTransport).map((a) => a["event.name"]));
}

for (const [how, hide] of [
  ["pagehide", (h: Harness) => h.deps.window?.dispatchEvent(new Event("pagehide"))],
  ["visibilitychange", (h: Harness) => h.document.hide()],
] as const) {
  test(`on ${how}, the hide hooks run and the summary is emitted before web's flush exports`, async () => {
    const h = harness();
    open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
    const rt = runtimeOf(open);
    assert.ok(rt);
    await open.forceFlush();
    const before = h.transport.requests.length;
    rt.emit("o11y.rum.frustration", { "o11y.rum.frustration.type": "dead" });
    const view = rt.views.current();
    assert.ok(view);
    let hooks = 0;
    rt.onHide(() => {
      hooks++;
      rt.summary.vital(view.id, "cls", 0.1);
    });
    hide(h);
    hide(h);
    await new Promise((r) => setTimeout(r, 0));
    await open.forceFlush();
    assert.equal(hooks, 1, "once per hide");
    const after = logRequests({
      ...h.transport,
      requests: h.transport.requests.slice(before),
    } as FakeTransport);
    assert.deepEqual(after[0], ["o11y.rum.frustration", "o11y.rum.view.summary"]);
    const summary = logRecords(h.transport).find((r) => r["event.name"] === "o11y.rum.view.summary");
    assert.equal(summary?.["o11y.rum.summary.cls.value"], 0.1);
  });
}

test("a page shown again is hidden again: the hooks run once per hide", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
  const rt = runtimeOf(open);
  assert.ok(rt);
  let hooks = 0;
  rt.onHide(() => hooks++);
  h.document.hide();
  h.deps.window?.dispatchEvent(new Event("pagehide"));
  assert.equal(hooks, 1);
  h.document.visibilityState = "visible";
  h.document.dispatchEvent(new Event("visibilitychange"));
  h.document.hide();
  assert.equal(hooks, 2);
});

test("a request that ends after a revoke leaves no breadcrumb for the next grant", async () => {
  const h = harness();
  open = await setupRumWith({ ...OPTS, consent: { initial: "granted" } }, h.deps);
  const rt = runtimeOf(open);
  assert.ok(rt);
  await open.consent.revoke();
  rt.bus.publish({ type: "breadcrumb", kind: "fetch", label: "GET api.test 200", at: 1 });
  open.consent.grant();
  await until(() => open?.rum.sessionId() !== undefined, "the session");
  assert.equal(
    rt.breadcrumbs().some((c) => c.startsWith("fetch")),
    false,
  );
});

test("a revoke and a grant while the session loads start the collectors once", async () => {
  const h = harness();
  let release: (() => void) | undefined;
  const gateLoad = new Promise<void>((r) => {
    release = r;
  });
  const base = h.deps.sessionStore;
  const deps: RumDeps = {
    ...h.deps,
    sessionStore: () => {
      const s = base();
      return {
        ...s,
        load: async () => {
          await gateLoad;
          return s.load();
        },
      };
    },
  };
  let starts = 0;
  open = await setupRumWith(
    {
      ...OPTS,
      rum: {
        collectors: [
          {
            name: "errors",
            start: () => {
              starts++;
              return () => {};
            },
          },
        ],
      },
    },
    deps,
  );
  open.consent.grant();
  await new Promise((r) => setTimeout(r, 0));
  await open.consent.revoke();
  open.consent.grant();
  await new Promise((r) => setTimeout(r, 0));
  release?.();
  await until(() => starts > 0, "the collector start");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(starts, 1);
});
