/**
 * setup and createTelemetry over injected dependencies (setupWithDeps), so the wiring is tested
 * without the transport, queue, consent and instrumentation work packages: fake consent, queue,
 * transport and delivery, and recording instrumentation installers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { O11yError, type TelemetryOptions } from "@libo11y/core";
import { exemplarStoreOf } from "@libo11y/core/testing";
import { trace } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace";
import { activeConsent, setActiveConsent } from "./consent/active.ts";
import type {
  Consent,
  ConsentController,
  ConsentControllerOptions,
  ConsentState,
} from "./contracts/consent.ts";
import type { QueueOptions } from "./contracts/queue.ts";
import type { Delivery, DeliveryOptions, SendMode } from "./contracts/transport.ts";
import type { VisibilitySource } from "./lifecycle.ts";
import type { DocumentLoadOptions, HttpInstrumentationOptions, WebSetupOptions } from "./options.ts";
import { type SetupDeps, setupWithDeps } from "./setup.ts";
import { createFakeQueue, createFakeTransport, type FakeQueue } from "./test-support/index.ts";
import { createDelivery } from "./transport/delivery.ts";
import type { SignalEndpoints } from "./transport/endpoints.ts";
import type { HttpTransportOptions } from "./transport/http.ts";

const ENDPOINTS: SignalEndpoints = {
  traces: "https://collector.example/v1/traces",
  metrics: undefined,
  logs: "https://collector.example/v1/logs",
};

/** A consent controller with the contract's state machine, minus the privacy signals. */
function fakeController(opts: ConsentControllerOptions): ConsentController {
  let state: ConsentState = opts.initial ?? "pending";
  const listeners: ((s: ConsentState) => void)[] = [];
  const gateListeners: ((r: boolean) => void)[] = [];
  const hooks: (() => void | Promise<void>)[] = [];
  const move = (next: ConsentState): void => {
    if (next === state) return;
    const was = state === "granted";
    state = next;
    for (const l of [...listeners]) l(state);
    if (was !== (state === "granted")) for (const l of [...gateListeners]) l(state === "granted");
  };
  const consent: Consent = {
    state: () => state,
    grant() {
      move("granted");
      return state;
    },
    async revoke() {
      move("denied");
      for (const h of [...hooks]) await h();
    },
    subscribe(l) {
      listeners.push(l);
      return () => listeners.splice(listeners.indexOf(l), 1);
    },
  };
  return {
    consent,
    recording: () => state === "granted",
    subscribe(l) {
      gateListeners.push(l);
      return () => gateListeners.splice(gateListeners.indexOf(l), 1);
    },
    onRevoke(hook) {
      hooks.push(hook);
      return () => {
        const i = hooks.indexOf(hook);
        if (i >= 0) hooks.splice(i, 1);
      };
    },
  };
}

class FakeDocument extends EventTarget implements VisibilitySource {
  visibilityState: DocumentVisibilityState = "visible";

  set(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

/** Everything a test observes, in the order it happened. */
interface Harness {
  readonly deps: SetupDeps;
  readonly log: string[];
  readonly controllers: ConsentController[];
  readonly controllerOptions: ConsentControllerOptions[];
  readonly queueOptions: QueueOptions[];
  readonly queues: FakeQueue[];
  readonly transportOptions: HttpTransportOptions[];
  readonly deliveryOptions: DeliveryOptions[];
  readonly endpointCalls: { opts: WebSetupOptions; hermetic: boolean }[];
  readonly fetchOptions: HttpInstrumentationOptions[];
  readonly xhrOptions: HttpInstrumentationOptions[];
  readonly documentLoadOptions: DocumentLoadOptions[];
  readonly document: FakeDocument;
  readonly window: EventTarget;
}

function harness(overrides: Partial<SetupDeps> = {}): Harness {
  const log: string[] = [];
  const h: Omit<Harness, "deps"> = {
    log,
    controllers: [],
    controllerOptions: [],
    queueOptions: [],
    queues: [],
    transportOptions: [],
    deliveryOptions: [],
    endpointCalls: [],
    fetchOptions: [],
    xhrOptions: [],
    documentLoadOptions: [],
    document: new FakeDocument(),
    window: new EventTarget(),
  };
  const deps: SetupDeps = {
    createConsentController(opts) {
      log.push("consent");
      h.controllerOptions.push(opts);
      const c = fakeController(opts);
      h.controllers.push(c);
      return c;
    },
    async openQueue(opts) {
      log.push("queue");
      h.queueOptions.push(opts);
      const q = createFakeQueue();
      const close = q.close.bind(q);
      q.close = () => {
        log.push("queue.close");
        close();
      };
      h.queues.push(q);
      return q;
    },
    resolveEndpoints(opts, hermetic) {
      log.push("endpoints");
      h.endpointCalls.push({ opts, hermetic });
      return ENDPOINTS;
    },
    createHttpTransport(opts) {
      log.push("transport");
      h.transportOptions.push(opts);
      return createFakeTransport();
    },
    createDelivery(opts): Delivery {
      log.push("delivery");
      h.deliveryOptions.push(opts);
      return {
        deliver: async () => ({ outcome: "sent" }),
        drain: async () => {
          log.push("delivery.drain");
        },
        clear: async () => {
          log.push("delivery.clear");
        },
        shutdown: async () => {
          log.push("delivery.shutdown");
        },
      };
    },
    createExporterSet() {
      log.push("exporters");
      return {};
    },
    installFetchInstrumentation(opts) {
      log.push("fetch.install");
      h.fetchOptions.push(opts);
      return () => log.push("fetch.uninstall");
    },
    installXhrInstrumentation(opts) {
      log.push("xhr.install");
      h.xhrOptions.push(opts);
      return () => log.push("xhr.uninstall");
    },
    recordDocumentLoad(opts) {
      log.push("documentLoad");
      h.documentLoadOptions.push(opts);
      return new Promise<void>((resolve) => {
        opts.signal?.addEventListener("abort", () => {
          log.push("documentLoad.abort");
          resolve();
        });
      });
    },
    document: h.document,
    window: h.window,
    ...overrides,
  };
  return { ...h, deps };
}

/** A span processor that logs its forceFlush and shutdown calls. */
function loggingProcessor(log: string[]): SpanProcessor {
  return {
    onStart: () => {},
    onEnd: (_span: ReadableSpan) => {},
    forceFlush: async () => {
      log.push("flush");
    },
    shutdown: async () => {
      log.push("providers.shutdown");
    },
  };
}

const BASE: TelemetryOptions = { serviceName: "shop", environment: "test", hermetic: true };

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

test("setup wires consent, queue, endpoints, transport, delivery and platform in order, then drains", async () => {
  const h = harness();
  const web = await setupWithDeps({ ...BASE, endpoint: "https://collector.example" }, h.deps, true);
  try {
    assert.deepEqual(h.log.slice(0, 5), ["consent", "queue", "endpoints", "transport", "delivery"]);
    assert.ok(h.log.includes("delivery.drain"));
    assert.ok(h.log.indexOf("delivery.drain") > h.log.indexOf("delivery"));
    assert.equal(h.endpointCalls[0]?.hermetic, true);
    assert.equal(h.endpointCalls[0]?.opts.endpoint, "https://collector.example");
  } finally {
    await web.shutdown();
  }
});

test("consent defaults to pending and handle.consent is the controller's consent", async () => {
  const h = harness();
  const web = await setupWithDeps(BASE, h.deps, true);
  try {
    assert.deepEqual(h.controllerOptions, [{}]);
    assert.equal(web.consent, h.controllers[0]?.consent);
    assert.equal(web.consent.state(), "pending");
  } finally {
    await web.shutdown();
  }
});

test("consent options reach the controller", async () => {
  const h = harness();
  const consent = { initial: "granted", respectDoNotTrack: true } as const;
  const web = await setupWithDeps({ ...BASE, consent }, h.deps, true);
  try {
    assert.deepEqual(h.controllerOptions, [consent]);
    assert.equal(web.consent.state(), "granted");
  } finally {
    await web.shutdown();
  }
});

test("the consent controller is the delivery's gate and the platform's gate", async () => {
  const h = harness();
  let platformGate: unknown;
  const web = await setupWithDeps(BASE, { ...h.deps, onPlatform: (p) => (platformGate = p.gate) }, true);
  try {
    assert.equal(h.deliveryOptions[0]?.gate, h.controllers[0]);
    assert.equal(platformGate, h.controllers[0]);
  } finally {
    await web.shutdown();
  }
});

test("transport options reach the queue, the HTTP transport and the delivery", async () => {
  const h = harness();
  const web = await setupWithDeps(
    {
      ...BASE,
      headers: { "x-api-key": "k" },
      transport: {
        compression: "none",
        databaseName: "shop-otlp",
        maxQueueBytes: 1000,
        maxQueueAgeMillis: 60_000,
        initialBackoffMillis: 50,
        maxBackoffMillis: 500,
        timeoutMillis: 2000,
      },
    },
    h.deps,
    true,
  );
  try {
    assert.deepEqual(h.queueOptions, [{ databaseName: "shop-otlp", maxBytes: 1000, maxAgeMillis: 60_000 }]);
    assert.deepEqual(h.transportOptions, [
      { endpoints: ENDPOINTS, headers: { "x-api-key": "k" }, compression: "none", timeoutMillis: 2000 },
    ]);
    const d = h.deliveryOptions[0];
    assert.equal(d?.queue, h.queues[0]);
    assert.equal(d?.initialBackoffMillis, 50);
    assert.equal(d?.maxBackoffMillis, 500);
  } finally {
    await web.shutdown();
  }
});

test("a transport timeout gets a delivery lease of at least twice it, the default lease otherwise", async () => {
  const leaseFor = async (transport: WebSetupOptions["transport"]): Promise<DeliveryOptions | undefined> => {
    const h = harness();
    const web = await setupWithDeps(
      { ...BASE, ...(transport === undefined ? {} : { transport }) },
      h.deps,
      true,
    );
    await web.shutdown();
    return h.deliveryOptions[0];
  };
  // The default timeout keeps the delivery's default lease.
  assert.equal((await leaseFor(undefined))?.leaseMillis, undefined);
  // A short timeout never shortens the lease below the default.
  assert.equal((await leaseFor({ timeoutMillis: 2000 }))?.leaseMillis ?? 30_000, 30_000);
  // A long one stretches it, so a lease never runs out while its send is on the wire.
  const long = (await leaseFor({ timeoutMillis: 20_000 }))?.leaseMillis ?? 30_000;
  assert.ok(long >= 2 * 20_000, `lease ${long} for a 20000 ms timeout`);
});

test("offlineQueue false opens no queue and gives the delivery none", async () => {
  const h = harness();
  const web = await setupWithDeps({ ...BASE, transport: { offlineQueue: false } }, h.deps, true);
  try {
    assert.equal(h.log.includes("queue"), false);
    assert.equal(h.deliveryOptions[0]?.queue, undefined);
    assert.equal("queue" in (h.deliveryOptions[0] ?? {}), false);
  } finally {
    await web.shutdown();
  }
  assert.equal(h.log.includes("queue.close"), false);
});

test("the send mode follows document visibility and pagehide", async () => {
  const h = harness();
  let platformMode: (() => SendMode) | undefined;
  const web = await setupWithDeps(BASE, { ...h.deps, onPlatform: (_p, o) => (platformMode = o.mode) }, true);
  try {
    const mode = h.deliveryOptions[0]?.mode;
    assert.ok(mode);
    assert.equal(platformMode, mode);
    assert.equal(mode(), "normal");
    h.document.set("hidden");
    assert.equal(mode(), "unload");
    h.document.set("visible");
    assert.equal(mode(), "normal");
    h.window.dispatchEvent(new Event("pagehide"));
    assert.equal(mode(), "unload");
    h.window.dispatchEvent(new Event("pageshow"));
    assert.equal(mode(), "normal");
  } finally {
    await web.shutdown();
  }
});

test("without a document the mode is always normal and nothing listens for hides", async () => {
  const h = harness();
  const web = await setupWithDeps(BASE, { ...h.deps, document: undefined, window: undefined }, true);
  try {
    assert.equal(h.deliveryOptions[0]?.mode?.(), "normal");
  } finally {
    await web.shutdown();
  }
});

test("console defaults to off; the option still turns it on", async () => {
  const original = console.log;
  const lines: string[] = [];
  console.log = (line: unknown) => {
    lines.push(String(line));
  };
  try {
    const quiet = await setupWithDeps(BASE, harness().deps, true);
    await quiet.shutdown();
    assert.deepEqual(lines, []);
    const loud = await setupWithDeps({ ...BASE, console: "json" }, harness().deps, true);
    await loud.shutdown();
    assert.ok(lines.some((l) => (JSON.parse(l) as { msg?: string }).msg === "o11y.telemetry.configured"));
  } finally {
    console.log = original;
  }
});

test("setup installs globals, the active consent and the instrumentation", async () => {
  const h = harness();
  const web = await setupWithDeps(
    {
      ...BASE,
      instrumentations: { propagateTo: ["https://api.example"], ignoreUrls: [/\/health$/] },
    },
    h.deps,
    true,
  );
  try {
    assert.equal(activeConsent(), web.consent);
    assert.notEqual(trace.getTracerProvider(), undefined);
    assert.ok(h.log.includes("fetch.install"));
    assert.ok(h.log.includes("xhr.install"));
    assert.ok(h.log.includes("documentLoad"));
    for (const opts of [h.fetchOptions[0], h.xhrOptions[0]]) {
      assert.equal(opts?.telemetry, web);
      assert.deepEqual(opts?.propagateTo, ["https://api.example"]);
      assert.deepEqual(opts?.ignoreUrls, [/\/health$/, ENDPOINTS.traces, ENDPOINTS.logs]);
    }
    assert.equal(h.documentLoadOptions[0]?.telemetry, web);
  } finally {
    await web.shutdown();
  }
});

test("each instrumentation can be turned off", async () => {
  const h = harness();
  const web = await setupWithDeps(
    { ...BASE, instrumentations: { fetch: false, xhr: false, documentLoad: false } },
    h.deps,
    true,
  );
  try {
    for (const step of ["fetch.install", "xhr.install", "documentLoad"]) {
      assert.equal(h.log.includes(step), false, step);
    }
  } finally {
    await web.shutdown();
  }
});

test("the default propagateTo is empty and ignoreUrls holds only the endpoints", async () => {
  const h = harness();
  const web = await setupWithDeps(BASE, h.deps, true);
  try {
    assert.deepEqual(h.fetchOptions[0]?.propagateTo, []);
    assert.deepEqual(h.fetchOptions[0]?.ignoreUrls, [ENDPOINTS.traces, ENDPOINTS.logs]);
  } finally {
    await web.shutdown();
  }
});

test("createTelemetry installs nothing global and no instrumentation, but still drains", async () => {
  const h = harness();
  const before = activeConsent();
  const web = await setupWithDeps({ ...BASE, console: "json" }, h.deps, false);
  try {
    assert.equal(activeConsent(), before);
    for (const step of ["fetch.install", "xhr.install", "documentLoad"]) {
      assert.equal(h.log.includes(step), false, step);
    }
    assert.ok(h.log.includes("delivery.drain"));
    assert.equal(web.consent.state(), "pending");
    // A second createTelemetry is allowed: no guard is taken.
    const again = await setupWithDeps(BASE, harness().deps, false);
    await again.shutdown();
  } finally {
    await web.shutdown();
  }
});

test("a hide flushes every provider, for setup and createTelemetry alike", async () => {
  for (const install of [true, false]) {
    const h = harness();
    const web = await setupWithDeps({ ...BASE, spanProcessor: loggingProcessor(h.log) }, h.deps, install);
    try {
      h.document.set("hidden");
      await tick();
      assert.equal(h.log.filter((s) => s === "flush").length, 1, `install=${install}`);
    } finally {
      await web.shutdown();
    }
    h.document.set("visible");
    h.document.set("hidden");
    await tick();
    assert.equal(h.log.filter((s) => s === "flush").length, 1, "no flush after shutdown");
  }
});

test("a hide whose flush fails reports it once through the telemetry's own reporter, for setup and createTelemetry alike", async () => {
  for (const install of [true, false]) {
    const h = harness();
    const web = await setupWithDeps(
      {
        ...BASE,
        spanProcessor: flushingProcessor(() =>
          Promise.reject(new Error("collector at https://secret.example")),
        ),
      },
      h.deps,
      install,
    );
    const reports: Error[] = [];
    (web as unknown as Record<symbol, unknown>)[Symbol.for("libo11y.report")] = (err: Error) =>
      reports.push(err);
    try {
      h.document.set("hidden");
      await tick();
      assert.deepEqual(
        reports.map((r) => r.message),
        ["o11y: flush on hide failed: traces (Error)"],
        `install=${install}`,
      );
    } finally {
      await web.shutdown();
    }
  }
});

test("revoke clears the delivery, then flushes the providers into the closed gate", async () => {
  const h = harness();
  const web = await setupWithDeps(
    { ...BASE, consent: { initial: "granted" }, spanProcessor: loggingProcessor(h.log) },
    h.deps,
    true,
  );
  try {
    const mark = h.log.length;
    await web.consent.revoke();
    assert.equal(web.consent.state(), "denied");
    assert.deepEqual(h.log.slice(mark), ["delivery.clear", "flush"]);
  } finally {
    await web.shutdown();
  }
});

/** A span processor whose forceFlush returns flush(). */
function flushingProcessor(flush: () => Promise<void>): SpanProcessor {
  return { onStart: () => {}, onEnd: () => {}, forceFlush: flush, shutdown: async () => {} };
}

/** A harness whose delivery is the real one, over the harness's queue and a fake transport. */
function realDeliveryHarness(): Harness {
  return harness({ createDelivery });
}

/** Puts a batch due in an hour into the harness's queue, so no drain sends it meanwhile. */
async function queued(h: Harness): Promise<FakeQueue> {
  const queue = h.queues[0];
  assert.ok(queue !== undefined);
  await queue.put({ signal: "traces", body: "{}", notBefore: Date.now() + 3_600_000 });
  assert.equal(queue.entries.size, 1);
  return queue;
}

test("revoke empties the queue at once while an export to an unreachable collector stalls the flush", async () => {
  // Core's forceFlush waits for exports in flight, up to its deadline. A revoke must not wait with
  // it: a page closed meanwhile would keep the queue, to be sent after a later grant.
  const h = realDeliveryHarness();
  let release = (): void => {};
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const web = await setupWithDeps(
    { ...BASE, consent: { initial: "granted" }, spanProcessor: flushingProcessor(() => stalled) },
    h.deps,
    true,
  );
  try {
    const queue = await queued(h);
    const revoked = web.consent.revoke();
    await tick();
    assert.equal(queue.entries.size, 0, "emptied while the flush is still pending");
    release();
    await revoked;
  } finally {
    release();
    await web.shutdown();
  }
});

test("revoke empties the queue even when the flush rejects", async () => {
  const h = realDeliveryHarness();
  const web = await setupWithDeps({ ...BASE, consent: { initial: "granted" } }, h.deps, true);
  try {
    const queue = await queued(h);
    // Core's own forceFlush never rejects; the revoke must not depend on that.
    web.forceFlush = () => Promise.reject(new Error("collector unreachable"));
    await assert.rejects(web.consent.revoke(), /collector unreachable/);
    assert.equal(queue.entries.size, 0);
  } finally {
    await web.shutdown();
  }
});

test("shutdown runs core's shutdown, then removes everything, once", async () => {
  const h = harness();
  const web = await setupWithDeps({ ...BASE, spanProcessor: loggingProcessor(h.log) }, h.deps, true);
  const first = web.shutdown();
  assert.equal(web.shutdown(), first);
  const report = await first;
  assert.equal(report.ok, true);
  const after = h.log.slice(h.log.indexOf("providers.shutdown"));
  for (const step of [
    "fetch.uninstall",
    "xhr.uninstall",
    "documentLoad.abort",
    "delivery.shutdown",
    "queue.close",
  ]) {
    assert.equal(after.filter((s) => s === step).length, 1, step);
  }
  assert.ok(after.indexOf("delivery.shutdown") < after.indexOf("queue.close"));
  assert.equal(activeConsent(), undefined);
  // The revoke hook is gone: a revoke after shutdown clears nothing.
  const mark = h.log.length;
  await web.consent.revoke();
  assert.deepEqual(h.log.slice(mark), []);
  // The guard is free again.
  const next = await setupWithDeps(BASE, harness().deps, true);
  await next.shutdown();
});

test("shutdown leaves another setup's active consent alone", async () => {
  const h = harness();
  const web = await setupWithDeps(BASE, h.deps, true);
  const other = fakeController({}).consent;
  setActiveConsent(other);
  try {
    await web.shutdown();
    assert.equal(activeConsent(), other);
  } finally {
    setActiveConsent(undefined);
  }
});

test("the handle is core's handle extended in place", async () => {
  const h = harness();
  const web = await setupWithDeps(BASE, h.deps, true);
  try {
    assert.doesNotThrow(() => exemplarStoreOf(web));
    assert.equal(typeof web.forceFlush, "function");
    assert.equal(typeof web.logger.info, "function");
  } finally {
    await web.shutdown();
  }
});

test("a second setup fails with ALREADY_SETUP and releases what it opened", async () => {
  const first = await setupWithDeps(BASE, harness().deps, true);
  try {
    const h = harness();
    await assert.rejects(
      setupWithDeps(BASE, h.deps, true),
      (err: unknown) => err instanceof O11yError && err.code === "ALREADY_SETUP",
    );
    assert.ok(h.log.includes("delivery.shutdown"));
    assert.ok(h.log.includes("queue.close"));
    assert.equal(h.log.includes("fetch.install"), false);
    assert.equal(activeConsent(), first.consent);
  } finally {
    await first.shutdown();
  }
});

test("a configuration error rejects and releases the delivery and queue", async () => {
  const h = harness();
  await assert.rejects(
    setupWithDeps({ ...BASE, piiMode: "hash" }, h.deps, false),
    (err: unknown) => err instanceof O11yError,
  );
  assert.ok(h.log.includes("delivery.shutdown"));
  assert.ok(h.log.includes("queue.close"));
});

test("an instrumentation that throws on install fails setup and leaves nothing installed", async () => {
  const h = harness({
    installXhrInstrumentation: () => {
      throw new Error("no xhr");
    },
  });
  await assert.rejects(setupWithDeps(BASE, h.deps, true), /no xhr/);
  assert.ok(h.log.includes("fetch.uninstall"));
  assert.ok(h.log.includes("delivery.shutdown"));
  assert.equal(activeConsent(), undefined);
  const next = await setupWithDeps(BASE, harness().deps, true);
  await next.shutdown();
});

test("platform name is web and the exporters come from the delivery", async () => {
  const h = harness();
  let name: string | undefined;
  const web = await setupWithDeps(
    { ...BASE, hermetic: false, env: {} },
    { ...h.deps, onPlatform: (p) => (name = p.name) },
    false,
  );
  try {
    assert.equal(name, "web");
    assert.ok(h.log.includes("exporters"));
  } finally {
    await web.shutdown();
  }
});

test("a failure after core set up shuts core down too, so the next setup is not ALREADY_SETUP", async () => {
  // A document whose visibilitychange listener cannot be added fails setup after setupWith.
  class RefusingDocument extends FakeDocument {
    override addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
      if (args[0] === "visibilitychange") throw new Error("no listeners here");
      super.addEventListener(...args);
    }
  }
  const h = harness({ document: new RefusingDocument() });
  const log: string[] = [];
  await assert.rejects(
    setupWithDeps({ ...BASE, spanProcessor: loggingProcessor(log) }, h.deps, true),
    /no listeners here/,
  );
  assert.ok(log.includes("providers.shutdown"), "core's providers are shut down");
  assert.ok(h.log.includes("delivery.shutdown"));
  assert.ok(h.log.includes("queue.close"));
  const next = await setupWithDeps(BASE, harness().deps, true);
  await next.shutdown();
});
