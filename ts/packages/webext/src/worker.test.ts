import assert from "node:assert/strict";
import { test } from "node:test";
import type { HttpInstrumentationOptions } from "@libo11y/web";
import {
  activeConsent,
  type ConsentControllerOptions,
  type HttpTransportOptions,
  type PersistentQueue,
  type QueueOptions,
  type WebPlatformOptions,
} from "@libo11y/web/internal";
import { context, trace } from "@opentelemetry/api";
import { createFakeQueue, createFakeTransport, testPlatform } from "../../web/src/test-support/index.ts";
import { CONSENT_STORAGE_KEY } from "./consent-sync.ts";
import type { WorkerSetupOptions, WorkerTelemetry } from "./options.ts";
import { createFakeExtension } from "./test-support/fake-chrome.ts";
import { createFakeConsentController, type FakeConsentController } from "./test-support/fake-consent.ts";
import { createFakeDelivery, type FakeDelivery } from "./test-support/fake-delivery.ts";
import { setupWorkerWith, WORKER_ENV_DEFAULTS, type WorkerDeps } from "./worker.ts";

const BASE: WorkerSetupOptions = { serviceName: "worker", environment: "test", startupSummary: false };

interface Seen {
  controllerOptions?: ConsentControllerOptions;
  controller?: FakeConsentController;
  queueOptions?: QueueOptions;
  transport?: HttpTransportOptions;
  delivery?: FakeDelivery;
  platform?: WebPlatformOptions;
  fetch: HttpInstrumentationOptions[];
}

function rig(opts: { stored?: unknown; queue?: PersistentQueue } = {}) {
  const ext = createFakeExtension("ext-id", { name: "fixture", version: "1.2.3" });
  if (opts.stored !== undefined) ext.stored.set(CONSENT_STORAGE_KEY, opts.stored);
  const worker = ext.context({ url: "chrome-extension://ext-id/worker.js" });
  const content = ext.context({ tabId: 5, url: "https://example.com/" });
  const log: string[] = [];
  const queue = opts.queue ?? createFakeQueue();
  const seen: Seen = { fetch: [] };
  const deps: WorkerDeps = {
    chrome: worker.chrome,
    createConsentController: (o) => {
      seen.controllerOptions = o;
      seen.controller = createFakeConsentController(o.initial ?? "pending");
      return seen.controller;
    },
    openQueue: async (o) => {
      seen.queueOptions = o;
      log.push("openQueue");
      return queue;
    },
    resolveEndpoints: () => ({
      traces: "https://collector.test/v1/traces",
      metrics: undefined,
      logs: "https://collector.test/v1/logs",
    }),
    createHttpTransport: (o) => {
      seen.transport = o;
      return createFakeTransport();
    },
    createDelivery: (o) => {
      seen.delivery = createFakeDelivery(o, log);
      return seen.delivery;
    },
    webPlatform: (o) => {
      seen.platform = o;
      return testPlatform({ gate: o.gate });
    },
    installFetchInstrumentation: (o) => {
      seen.fetch.push(o);
      log.push("fetch installed");
      return () => log.push("fetch removed");
    },
  };
  return { ext, worker, content, queue, log, seen, deps };
}

async function withWorker(
  r: ReturnType<typeof rig>,
  options: WorkerSetupOptions,
  body: (handle: WorkerTelemetry) => Promise<void>,
): Promise<void> {
  const handle = await setupWorkerWith(options, r.deps);
  try {
    await body(handle);
  } finally {
    await handle.shutdown();
  }
}

const exportMessage = (body = '{"resourceSpans":[]}') => ({
  libo11y: 1,
  type: "export",
  signal: "traces",
  body,
});

test("the worker is wired for a worker: persist first, no beacon, mode normal, short delays", async () => {
  const r = rig();
  await withWorker(
    r,
    { ...BASE, headers: { a: "b" }, transport: { databaseName: "wdb", timeoutMillis: 5 } },
    async () => {
      assert.ok(r.seen.transport);
      assert.ok(Object.hasOwn(r.seen.transport, "sendBeacon"));
      assert.equal(r.seen.transport.sendBeacon, undefined);
      assert.deepEqual(r.seen.transport.headers, { a: "b" });
      assert.equal(r.seen.transport.timeoutMillis, 5);
      assert.equal(r.seen.transport.endpoints.traces, "https://collector.test/v1/traces");
      assert.equal(r.seen.queueOptions?.databaseName, "wdb");
      const d = r.seen.delivery?.options;
      assert.equal(d?.persistFirst, true);
      assert.equal(d?.mode?.(), "normal");
      assert.equal(d?.queue, r.queue);
      assert.equal(d?.gate, r.seen.controller);
      const p = r.seen.platform;
      assert.equal(p?.name, "webext");
      assert.equal(p?.mode?.(), "normal");
      assert.deepEqual(p?.envDefaults, WORKER_ENV_DEFAULTS);
      assert.equal(p?.delivery, r.seen.delivery);
      assert.equal(p?.gate, r.seen.controller);
    },
  );
});

test("service.version defaults to the manifest version", async () => {
  const r = rig();
  await withWorker(r, BASE, async (h) => {
    assert.equal(h.resource.attributes["service.version"], "1.2.3");
  });
  const r2 = rig();
  await withWorker(r2, { ...BASE, serviceVersion: "9.9.9" }, async (h) => {
    assert.equal(h.resource.attributes["service.version"], "9.9.9");
  });
});

test("a stored consent beats options.consent.initial", async () => {
  const r = rig({ stored: "granted" });
  await withWorker(r, { ...BASE, consent: { initial: "pending", respectDoNotTrack: true } }, async (h) => {
    assert.equal(r.seen.controllerOptions?.initial, "granted");
    assert.equal(r.seen.controllerOptions?.respectDoNotTrack, true);
    assert.equal(h.consent.state(), "granted");
  });
});

test("without a stored state the initial state is used and stored, unless it is pending", async () => {
  const r = rig();
  await withWorker(r, { ...BASE, consent: { initial: "granted" } }, async () => {
    await r.ext.settle();
    assert.equal(r.ext.stored.get(CONSENT_STORAGE_KEY), "granted");
  });
  const r2 = rig();
  await withWorker(r2, BASE, async (h) => {
    await r2.ext.settle();
    assert.equal(h.consent.state(), "pending");
    assert.equal(r2.ext.stored.has(CONSENT_STORAGE_KEY), false);
  });
});

test("consent follows storage: a grant in another context opens the worker's gate", async () => {
  const r = rig();
  await withWorker(r, BASE, async (h) => {
    await r.content.chrome.storage?.local.set({ [CONSENT_STORAGE_KEY]: "granted" });
    await r.ext.settle();
    assert.equal(h.consent.state(), "granted");
  });
});

test("an accepted batch is persisted, then answered, then drained", async () => {
  const r = rig({ stored: "granted" });
  await withWorker(r, BASE, async () => {
    r.log.length = 0;
    const reply = await r.content.chrome.runtime.sendMessage(exportMessage('{"a":1}'));
    assert.deepEqual(reply, { libo11y: 1, type: "export-reply", ok: true });
    const entries = [...(r.queue as ReturnType<typeof createFakeQueue>).entries.values()];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.signal, "traces");
    assert.equal(entries[0]?.body, '{"a":1}');
    await r.ext.settle();
    assert.deepEqual(r.log, ["drain"]);
  });
});

test("a batch while consent is closed is refused and not stored", async () => {
  const r = rig();
  await withWorker(r, BASE, async () => {
    const reply = (await r.content.chrome.runtime.sendMessage(exportMessage())) as {
      ok: boolean;
      reason?: string;
    };
    assert.equal(reply.ok, false);
    assert.match(reply.reason ?? "", /consent/);
    assert.equal((r.queue as ReturnType<typeof createFakeQueue>).entries.size, 0);
  });
});

test("a malformed export is refused", async () => {
  const r = rig({ stored: "granted" });
  await withWorker(r, BASE, async () => {
    for (const bad of [
      { libo11y: 1, type: "export", signal: "profiles", body: "{}" },
      { libo11y: 1, type: "export", signal: "traces", body: { resourceSpans: [] } },
    ]) {
      const reply = (await r.content.chrome.runtime.sendMessage(bad)) as { ok: boolean; reason?: string };
      assert.equal(reply.ok, false);
      assert.match(reply.reason ?? "", /malformed/);
    }
    assert.equal((r.queue as ReturnType<typeof createFakeQueue>).entries.size, 0);
  });
});

test("a batch the queue refuses is refused", async () => {
  const queue = createFakeQueue();
  const refusing: PersistentQueue = { ...queue, put: async () => undefined };
  const r = rig({ stored: "granted", queue: refusing });
  await withWorker(r, BASE, async () => {
    const reply = (await r.content.chrome.runtime.sendMessage(exportMessage())) as {
      ok: boolean;
      reason?: string;
    };
    assert.equal(reply.ok, false);
    assert.match(reply.reason ?? "", /queue/);
  });
});

test("a batch from another extension is ignored", async () => {
  const r = rig({ stored: "granted" });
  const foreign = r.ext.context({ senderId: "someone-else", tabId: 9 });
  await withWorker(r, BASE, async () => {
    await assert.rejects(foreign.chrome.runtime.sendMessage(exportMessage()));
    assert.equal((r.queue as ReturnType<typeof createFakeQueue>).entries.size, 0);
  });
});

test("other messages are left to other listeners", async () => {
  const r = rig({ stored: "granted" });
  await withWorker(r, BASE, async () => {
    r.worker.chrome.runtime.onMessage.addListener((m, _s, reply) => {
      if ((m as { type?: string }).type !== "wake") return undefined;
      reply({ wakes: 1 });
      return undefined;
    });
    assert.deepEqual(await r.content.chrome.runtime.sendMessage({ type: "wake" }), { wakes: 1 });
    await assert.rejects(
      r.content.chrome.runtime.sendMessage({ libo11y: 1, type: "export-reply", ok: true }),
    );
  });
});

test("acceptForwarded false registers no export listener", async () => {
  const r = rig({ stored: "granted" });
  await withWorker(r, { ...BASE, acceptForwarded: false }, async () => {
    // The holder of early traced messages goes one task after setup resolves.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(r.worker.listeners().length, 0);
    await assert.rejects(r.content.chrome.runtime.sendMessage(exportMessage()));
  });
});

test("a batch that arrives while the worker is still setting up is answered once it is ready", async () => {
  const r = rig({ stored: "granted" });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: WorkerDeps = {
    ...r.deps,
    openQueue: async (o) => {
      await gate;
      return r.deps.openQueue(o);
    },
  };
  const pending = setupWorkerWith(BASE, slow);
  // The listeners exist before the first await, so the message that woke the worker is caught:
  // the export listener and the holder of early traced messages.
  assert.equal(r.worker.listeners().length, 2);
  const reply = r.content.chrome.runtime.sendMessage(exportMessage());
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const handle = await pending;
  try {
    assert.deepEqual(await reply, { libo11y: 1, type: "export-reply", ok: true });
  } finally {
    await handle.shutdown();
  }
});

test("a failed setup removes the listener and refuses what waited", async () => {
  const r = rig({ stored: "granted" });
  const failing: WorkerDeps = {
    ...r.deps,
    openQueue: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("no queue");
    },
  };
  const pending = setupWorkerWith(BASE, failing);
  const reply = r.content.chrome.runtime.sendMessage(exportMessage());
  await assert.rejects(pending, /no queue/);
  const answer = (await reply) as { ok: boolean; reason?: string };
  assert.equal(answer.ok, false);
  assert.equal(r.worker.listeners().length, 0);
});

test("a bad configuration rejects like setup", async () => {
  const r = rig();
  await assert.rejects(setupWorkerWith({ startupSummary: false }, r.deps), { code: "NO_SERVICE_NAME" });
  assert.equal(r.worker.listeners().length, 0);
  // The guard was released: a good setup works afterwards.
  await withWorker(rig(), BASE, async () => {});
});

test("a second setup fails ALREADY_SETUP and leaves the first working", async () => {
  const r = rig({ stored: "granted" });
  await withWorker(r, BASE, async () => {
    const r2 = rig();
    await assert.rejects(setupWorkerWith(BASE, r2.deps), { code: "ALREADY_SETUP" });
    assert.equal(r2.worker.listeners().length, 0);
  });
});

test("the queue is drained once the worker is up, on every wake", async () => {
  const r = rig();
  await withWorker(r, BASE, async () => {
    assert.equal(r.log.filter((l) => l === "drain").length, 1);
    assert.ok(r.log.indexOf("drain") > r.log.indexOf("openQueue"));
  });
});

test("revoke flushes into the closed gate, then clears the delivery and its queue", async () => {
  const r = rig({ stored: "granted" });
  await withWorker(r, BASE, async (h) => {
    await r.content.chrome.runtime.sendMessage(exportMessage());
    assert.equal((r.queue as ReturnType<typeof createFakeQueue>).entries.size, 1);
    await h.consent.revoke();
    assert.ok(r.log.includes("clear"));
    assert.equal((r.queue as ReturnType<typeof createFakeQueue>).entries.size, 0);
    await r.ext.settle();
    assert.equal(r.ext.stored.get(CONSENT_STORAGE_KEY), "denied");
  });
});

test("a revoke from another context clears the worker's queue", async () => {
  const r = rig({ stored: "granted" });
  await withWorker(r, BASE, async () => {
    await r.content.chrome.runtime.sendMessage(exportMessage());
    await r.content.chrome.storage?.local.set({ [CONSENT_STORAGE_KEY]: "denied" });
    await r.ext.settle();
    assert.ok(r.log.includes("clear"));
    assert.equal((r.queue as ReturnType<typeof createFakeQueue>).entries.size, 0);
  });
});

test("the worker's fetch is instrumented by default, with the endpoints ignored", async () => {
  const r = rig();
  await withWorker(
    r,
    { ...BASE, fetch: { propagateTo: ["https://api.test"], ignoreUrls: ["https://x/"] } },
    async (h) => {
      assert.equal(r.seen.fetch.length, 1);
      const o = r.seen.fetch[0];
      assert.equal(o?.telemetry, h);
      assert.deepEqual(o?.propagateTo, ["https://api.test"]);
      assert.deepEqual(o?.ignoreUrls, [
        "https://x/",
        "https://collector.test/v1/traces",
        "https://collector.test/v1/logs",
      ]);
    },
  );
  assert.ok(r.log.includes("fetch removed"));
  const r2 = rig();
  await withWorker(r2, { ...BASE, fetch: false }, async () => {
    assert.equal(r2.seen.fetch.length, 0);
  });
  const r3 = rig();
  await withWorker(r3, BASE, async () => {
    assert.deepEqual(r3.seen.fetch[0]?.propagateTo, []);
  });
});

test("the handle is core's, with consent, the active consent and traced messaging", async () => {
  const r = rig({ stored: "granted" });
  await withWorker(r, BASE, async (h) => {
    assert.equal(h.consent, r.seen.controller?.consent);
    assert.equal(activeConsent(), h.consent);
    h.onMessage((payload, sender) => ({
      payload,
      tab: sender.tab?.id,
      traceId: trace.getSpan(context.active())?.spanContext().traceId,
    }));
    const tracer = h.tracerProvider.getTracer("t");
    const span = tracer.startSpan("content-op");
    const content = (await import("./messaging.ts")).createTracedMessaging(r.content.chrome, h.propagator);
    const reply = await context.with(trace.setSpan(context.active(), span), () => content.sendMessage("hi"));
    span.end();
    assert.deepEqual(reply, { payload: "hi", tab: 5, traceId: span.spanContext().traceId });

    content.onMessage((payload) => `tab got ${String(payload)}`);
    assert.equal(await h.sendTabMessage(5, "x"), "tab got x");
  });
  assert.equal(activeConsent(), undefined);
});

test("shutdown removes the listeners, stops the delivery and closes the queue, once", async () => {
  let closed = 0;
  const queue = createFakeQueue();
  const counting: PersistentQueue = {
    ...queue,
    close() {
      closed++;
    },
  };
  const r2 = rig({ stored: "granted", queue: counting });
  const h = await setupWorkerWith(BASE, r2.deps);
  const first = h.shutdown();
  assert.equal(h.shutdown(), first);
  await first;
  assert.equal(r2.worker.listeners().length, 0);
  assert.equal(r2.log.filter((l) => l === "shutdown").length, 1);
  assert.equal(closed, 1);
  // Consent changes are no longer written.
  h.consent.grant();
  await h.consent.revoke();
  await r2.ext.settle();
  assert.equal(r2.ext.writes.length, 0);
});

test("without the extension API setupWorker rejects", async () => {
  const r = rig();
  await assert.rejects(setupWorkerWith(BASE, { ...r.deps, chrome: undefined }), /chrome/);
});

test("with the real consent controller and IndexedDB queue, a batch is durable before the reply", async () => {
  const { IDBFactory } = await import("fake-indexeddb");
  const { createConsentController, openQueue } = await import("@libo11y/web/internal");
  const factory = new IDBFactory();
  const r = rig({ stored: "granted" });
  const deps: WorkerDeps = {
    ...r.deps,
    createConsentController,
    openQueue: (o) => openQueue({ ...o, indexedDB: factory }),
  };
  const h = await setupWorkerWith(BASE, deps);
  try {
    assert.equal(h.consent.state(), "granted");
    const reply = await r.content.chrome.runtime.sendMessage(exportMessage('{"durable":true}'));
    assert.deepEqual(reply, { libo11y: 1, type: "export-reply", ok: true });
    // A second connection, as the next wake of the worker would open, sees the batch.
    const next = await openQueue({ indexedDB: factory });
    try {
      assert.equal(next.kind, "indexeddb");
      const claimed = await next.claim(Date.now(), 10, 1000);
      assert.deepEqual(
        claimed.map((e) => e.body),
        ['{"durable":true}'],
      );
    } finally {
      next.close();
    }
  } finally {
    await h.shutdown();
  }
});

// slowRig is a rig whose openQueue waits for release, so a test can deliver messages to a worker
// that is still setting up, as the message that woke it is.
function slowRig(opts: { stored?: unknown } = {}) {
  const r = rig(opts);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deps: WorkerDeps = {
    ...r.deps,
    openQueue: async (o) => {
      await gate;
      return r.deps.openQueue(o);
    },
  };
  return { ...r, deps, release };
}

const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

test("a traced message that woke the worker reaches the listener added once setup resolves", async () => {
  const r = slowRig({ stored: "granted" });
  const pending = setupWorkerWith(BASE, r.deps);
  const reply = r.content.chrome.runtime.sendMessage({
    libo11y: 1,
    type: "traced",
    carrier: { traceparent: TRACEPARENT },
    payload: "early",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  r.release();
  const h = await pending;
  try {
    // Added after the await, as an application can only add it.
    h.onMessage((payload) => ({
      payload,
      traceId: trace.getSpan(context.active())?.spanContext().traceId,
    }));
    assert.deepEqual(await reply, {
      libo11y: 1,
      type: "traced-reply",
      ok: true,
      result: { payload: "early", traceId: "0af7651916cd43dd8448eb211c80319c" },
    });
    // Later traced messages reach the listener directly, once each.
    let calls = 0;
    h.onMessage(() => {
      calls++;
      return undefined;
    });
    await r.content.chrome.runtime.sendMessage({ libo11y: 1, type: "traced", carrier: {}, payload: 2 });
    assert.equal(calls, 1);
  } finally {
    await h.shutdown();
  }
});

test("an early traced message the worker has no listener for is left to other contexts", async () => {
  const r = slowRig({ stored: "granted" });
  const page = r.ext.context({ url: "chrome-extension://ext-id/page.html" });
  page.chrome.runtime.onMessage.addListener((m, _s, sendResponse) => {
    if ((m as { type?: string }).type !== "traced") return undefined;
    setTimeout(() => sendResponse({ libo11y: 1, type: "traced-reply", ok: true, result: "page" }), 30);
    return true;
  });
  const pending = setupWorkerWith(BASE, r.deps);
  const reply = r.content.chrome.runtime.sendMessage({ libo11y: 1, type: "traced", carrier: {}, payload: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  r.release();
  const h = await pending;
  try {
    assert.deepEqual(await reply, { libo11y: 1, type: "traced-reply", ok: true, result: "page" });
  } finally {
    await h.shutdown();
  }
});

test("a batch sent right after a grant elsewhere is accepted before the worker sees the change", async () => {
  const r = rig();
  await withWorker(r, BASE, async (h) => {
    await r.ext.settle();
    assert.equal(h.consent.state(), "pending");
    // Another context granted; its storage.onChanged has not reached the worker yet.
    r.ext.stored.set(CONSENT_STORAGE_KEY, "granted");
    const reply = await r.content.chrome.runtime.sendMessage(exportMessage());
    assert.deepEqual(reply, { libo11y: 1, type: "export-reply", ok: true });
    assert.equal(h.consent.state(), "granted");
    assert.equal((r.queue as ReturnType<typeof createFakeQueue>).entries.size, 1);
  });
});

test("a batch sent right after a revoke elsewhere is refused before the worker sees the change", async () => {
  const r = rig({ stored: "granted" });
  await withWorker(r, BASE, async (h) => {
    await r.ext.settle();
    assert.equal(h.consent.state(), "granted");
    r.ext.stored.set(CONSENT_STORAGE_KEY, "denied");
    const reply = (await r.content.chrome.runtime.sendMessage(exportMessage())) as { ok: boolean };
    assert.equal(reply.ok, false);
    assert.equal(h.consent.state(), "denied");
    assert.equal((r.queue as ReturnType<typeof createFakeQueue>).entries.size, 0);
  });
});

test("a queue that throws gets a refusal, not silence", async () => {
  const queue = createFakeQueue();
  const throwing: PersistentQueue = {
    ...queue,
    put: async () => {
      throw new Error("disk on fire");
    },
  };
  const r = rig({ stored: "granted", queue: throwing });
  await withWorker(r, BASE, async () => {
    const reply = (await Promise.race([
      r.content.chrome.runtime.sendMessage(exportMessage()),
      new Promise((resolve) => setTimeout(() => resolve("no reply"), 500)),
    ])) as { ok?: boolean; reason?: string } | string;
    assert.notEqual(reply, "no reply");
    assert.equal((reply as { ok: boolean }).ok, false);
  });
});

test("an accepted batch is drained even when the reply cannot be sent", async () => {
  const r = rig({ stored: "granted" });
  await withWorker(r, BASE, async () => {
    const [listener] = r.worker.listeners();
    assert.ok(listener);
    r.log.length = 0;
    const kept = listener(exportMessage(), { id: "ext-id" }, () => {
      throw new Error("Attempting to use a disconnected port object");
    });
    assert.equal(kept, true);
    await r.ext.settle();
    assert.deepEqual(r.log, ["drain"]);
  });
});

test("a revoke while a batch is being stored leaves nothing in the queue", async () => {
  const queue = createFakeQueue();
  let revoke: () => Promise<void> = async () => {};
  const revoking: PersistentQueue = {
    ...queue,
    // The revoke and its queue clear run while the put is in flight; the put lands after the clear.
    put: async (b) => {
      await revoke();
      return queue.put(b);
    },
  };
  const r = rig({ stored: "granted", queue: revoking });
  await withWorker(r, BASE, async (h) => {
    await r.ext.settle();
    revoke = () => h.consent.revoke();
    const reply = (await r.content.chrome.runtime.sendMessage(exportMessage())) as { ok: boolean };
    assert.equal(reply.ok, false);
    assert.equal(queue.entries.size, 0);
  });
});
