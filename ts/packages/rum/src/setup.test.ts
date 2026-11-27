import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { O11yError } from "@libo11y/core";
import {
  createMemoryQueue,
  defaultSetupDeps,
  type HttpTransportOptions,
  type SetupDeps,
} from "@libo11y/web/internal";
import { createFakeTransport, type FakeTransport } from "../../web/src/test-support/index.ts";
import type { RumSetupOptions, RumTelemetry } from "./options.ts";
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

function harness(): Harness {
  const transport = createFakeTransport();
  const storage = createFakeStorage();
  const hub = createChannelHub();
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
      openRetentionQueue: async (o) => createMemoryQueue(o),
      sessionStore: () => localStorageSessionStore({ storage, channel: hub.channel() }),
      now: Date.now,
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
  assert.equal(runtimeOf(open)?.views.current()?.kind, "initial");
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
