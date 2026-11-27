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
