import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocumentLoadOptions, HttpInstrumentationOptions } from "@libo11y/web";
import {
  activeConsent,
  type ConsentControllerOptions,
  type VisibilitySource,
  type WebPlatformOptions,
} from "@libo11y/web/internal";
import { createFakeQueue, testPlatform } from "../../web/src/test-support/index.ts";
import { CONSENT_STORAGE_KEY } from "./consent-sync.ts";
import { type ContentDeps, setupContentScriptWith, WORKER_ENDPOINT } from "./content.ts";
import { createTracedMessaging } from "./messaging.ts";
import type { ContentScriptSetupOptions, ContentScriptTelemetry } from "./options.ts";
import { isExportMessage } from "./protocol.ts";
import { createFakeExtension } from "./test-support/fake-chrome.ts";
import { createFakeConsentController, type FakeConsentController } from "./test-support/fake-consent.ts";
import { createFakeDelivery, type FakeDelivery } from "./test-support/fake-delivery.ts";

const BASE: ContentScriptSetupOptions = {
  serviceName: "content",
  environment: "test",
  startupSummary: false,
};

interface Seen {
  controllerOptions?: ConsentControllerOptions;
  controller?: FakeConsentController;
  delivery?: FakeDelivery;
  platform?: WebPlatformOptions;
  fetch: HttpInstrumentationOptions[];
  xhr: HttpInstrumentationOptions[];
  documentLoad: DocumentLoadOptions[];
  hide: { target: VisibilitySource; win: EventTarget | undefined; flush: () => Promise<unknown> }[];
}

function fakeDocument(): VisibilitySource {
  const target = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
  target.visibilityState = "visible";
  return target;
}

function rig(opts: { stored?: unknown; protocol?: string; noDocument?: boolean } = {}) {
  const ext = createFakeExtension("ext-id", { name: "fixture", version: "1.2.3" });
  if (opts.stored !== undefined) ext.stored.set(CONSENT_STORAGE_KEY, opts.stored);
  const worker = ext.context({ url: "chrome-extension://ext-id/worker.js" });
  const content = ext.context({ tabId: 4, url: "https://example.com/" });
  const log: string[] = [];
  const lines: string[] = [];
  const queue = createFakeQueue();
  const seen: Seen = { fetch: [], xhr: [], documentLoad: [], hide: [] };
  const doc = opts.noDocument === true ? undefined : fakeDocument();
  const win = opts.noDocument === true ? undefined : new EventTarget();
  const deps: ContentDeps = {
    chrome: content.chrome,
    createConsentController: (o) => {
      seen.controllerOptions = o;
      seen.controller = createFakeConsentController(o.initial ?? "pending");
      return seen.controller;
    },
    createMemoryQueue: () => queue,
    createDelivery: (o) => {
      seen.delivery = createFakeDelivery(o, log);
      return seen.delivery;
    },
    webPlatform: (o) => {
      seen.platform = o;
      return testPlatform({ gate: o.gate, lines });
    },
    installFetchInstrumentation: (o) => {
      seen.fetch.push(o);
      return () => log.push("fetch removed");
    },
    installXhrInstrumentation: (o) => {
      seen.xhr.push(o);
      return () => log.push("xhr removed");
    },
    recordDocumentLoad: async (o) => {
      seen.documentLoad.push(o);
    },
    installFlushOnHide: (target, w, flush) => {
      seen.hide.push({ target, win: w, flush });
      return () => log.push("hide removed");
    },
    document: doc,
    window: win,
    location: { protocol: opts.protocol ?? "https:" },
  };
  return { ext, worker, content, queue, log, lines, seen, deps, doc, win };
}

async function withContent(
  r: ReturnType<typeof rig>,
  options: ContentScriptSetupOptions,
  body: (handle: ContentScriptTelemetry) => Promise<void>,
): Promise<void> {
  const handle = await setupContentScriptWith(options, r.deps);
  try {
    await body(handle);
  } finally {
    await handle.shutdown();
  }
}

test("consent starts from the stored state, else pending", async () => {
  const r = rig({ stored: "granted" });
  await withContent(r, BASE, async (h) => {
    assert.equal(r.seen.controllerOptions?.initial, "granted");
    assert.equal(h.consent.state(), "granted");
  });
  const r2 = rig();
  await withContent(r2, BASE, async (h) => {
    assert.equal(h.consent.state(), "pending");
    await r2.ext.settle();
    // A content script never stores a state it did not change.
    assert.equal(r2.ext.writes.length, 0);
  });
});

test("consent is synced: a grant here is stored, a revoke elsewhere is applied", async () => {
  const r = rig();
  await withContent(r, BASE, async (h) => {
    assert.equal(h.consent.grant(), "granted");
    await r.ext.settle();
    assert.equal(r.ext.stored.get(CONSENT_STORAGE_KEY), "granted");
    await r.worker.chrome.storage?.local.set({ [CONSENT_STORAGE_KEY]: "denied" });
    await r.ext.settle();
    assert.equal(h.consent.state(), "denied");
    assert.ok(r.log.includes("clear"));
  });
});

test("batches go to the worker as ExportMessages over a memory queue", async () => {
  const r = rig({ stored: "granted" });
  const received: unknown[] = [];
  r.worker.chrome.runtime.onMessage.addListener((m, _s, reply) => {
    received.push(m);
    reply({ libo11y: 1, type: "export-reply", ok: true });
    return undefined;
  });
  await withContent(r, BASE, async () => {
    const d = r.seen.delivery?.options;
    assert.equal(d?.queue, r.queue);
    assert.equal(d?.gate, r.seen.controller);
    assert.equal(d?.mode?.(), "normal");
    assert.equal(d?.persistFirst ?? false, false);
    const result = await d?.transport.send({ signal: "logs", body: '{"resourceLogs":[]}', mode: "normal" });
    assert.deepEqual(result, { kind: "ok" });
    assert.equal(received.length, 1);
    assert.ok(isExportMessage(received[0]));
  });
});

test("the platform is webext with every signal pointed at the worker", async () => {
  const r = rig();
  await withContent(r, { ...BASE, env: { OTEL_TRACES_SAMPLER: "always_on" }, userAgent: true }, async () => {
    const p = r.seen.platform;
    assert.equal(p?.name, "webext");
    assert.deepEqual(p?.endpoints, {
      traces: WORKER_ENDPOINT,
      metrics: WORKER_ENDPOINT,
      logs: WORKER_ENDPOINT,
    });
    assert.equal(WORKER_ENDPOINT, "libo11y-webext:worker");
    assert.equal(p?.mode?.(), "normal");
    assert.deepEqual(p?.exportOptions.env, { OTEL_TRACES_SAMPLER: "always_on" });
    assert.equal(p?.exportOptions.userAgent, true);
    assert.equal(p?.delivery, r.seen.delivery);
  });
});

test("the console sink defaults to off", async () => {
  const r = rig();
  await withContent(r, BASE, async (h) => {
    h.logger.info("quiet");
    assert.deepEqual(r.lines, []);
  });
  const r2 = rig();
  await withContent(r2, { ...BASE, console: "json" }, async (h) => {
    h.logger.info("loud");
    assert.equal(r2.lines.length, 1);
  });
});

test("fetch and XHR are instrumented, documentLoad is off in a content script", async () => {
  const r = rig();
  await withContent(r, { ...BASE, instrumentations: { propagateTo: ["https://api.test"] } }, async (h) => {
    assert.equal(r.seen.fetch.length, 1);
    assert.equal(r.seen.xhr.length, 1);
    assert.equal(r.seen.fetch[0]?.telemetry, h);
    assert.deepEqual(r.seen.fetch[0]?.propagateTo, ["https://api.test"]);
    assert.deepEqual(r.seen.xhr[0]?.ignoreUrls, []);
    assert.equal(r.seen.documentLoad.length, 0);
  });
  assert.ok(r.log.includes("fetch removed"));
  assert.ok(r.log.includes("xhr removed"));
});

test("documentLoad defaults to on in an extension page, and the options override both ways", async () => {
  const r = rig({ protocol: "chrome-extension:" });
  await withContent(r, BASE, async (h) => {
    assert.equal(r.seen.documentLoad.length, 1);
    assert.equal(r.seen.documentLoad[0]?.telemetry, h);
  });
  assert.equal(r.seen.documentLoad[0]?.signal?.aborted, true);
  const r2 = rig({ protocol: "chrome-extension:" });
  await withContent(
    r2,
    { ...BASE, instrumentations: { documentLoad: false, fetch: false, xhr: false } },
    async () => {
      assert.equal(r2.seen.documentLoad.length, 0);
      assert.equal(r2.seen.fetch.length, 0);
      assert.equal(r2.seen.xhr.length, 0);
    },
  );
  const r3 = rig();
  await withContent(r3, { ...BASE, instrumentations: { documentLoad: true } }, async () => {
    assert.equal(r3.seen.documentLoad.length, 1);
  });
});

test("it flushes on hide where there is a document", async () => {
  const r = rig();
  await withContent(r, BASE, async () => {
    assert.equal(r.seen.hide.length, 1);
    assert.equal(r.seen.hide[0]?.target, r.doc);
    assert.equal(r.seen.hide[0]?.win, r.win);
    const report = (await r.seen.hide[0]?.flush()) as { ok: boolean };
    assert.equal(report.ok, true);
  });
  assert.ok(r.log.includes("hide removed"));
  const r2 = rig({ noDocument: true });
  await withContent(r2, BASE, async () => {
    assert.equal(r2.seen.hide.length, 0);
  });
});

test("revoke clears the delivery", async () => {
  const r = rig({ stored: "granted" });
  await withContent(r, BASE, async (h) => {
    await h.consent.revoke();
    assert.ok(r.log.includes("clear"));
  });
});

test("the handle is core's, with consent, the active consent and traced messaging", async () => {
  const r = rig({ stored: "granted" });
  const worker = createTracedMessaging(r.worker.chrome, {
    inject() {},
    extract: (c) => c,
    fields: () => [],
  });
  worker.onMessage((payload, sender) => ({ payload, tab: sender.tab?.id }));
  await withContent(r, BASE, async (h) => {
    assert.equal(h.consent, r.seen.controller?.consent);
    assert.equal(activeConsent(), h.consent);
    assert.deepEqual(await h.sendMessage("hello"), { payload: "hello", tab: 4 });
    const sent = r.ext.sent.at(-1) as { carrier: Record<string, string> };
    assert.ok("carrier" in sent);
  });
  assert.equal(activeConsent(), undefined);
});

test("shutdown stops the delivery and closes the queue, once", async () => {
  const r = rig();
  let closed = 0;
  r.deps = {
    ...r.deps,
    createMemoryQueue: () => ({
      ...r.queue,
      close() {
        closed++;
      },
    }),
  };
  const h = await setupContentScriptWith(BASE, r.deps);
  const first = h.shutdown();
  assert.equal(h.shutdown(), first);
  await first;
  assert.equal(r.log.filter((l) => l === "shutdown").length, 1);
  assert.equal(closed, 1);
  h.consent.grant();
  await r.ext.settle();
  assert.equal(r.ext.writes.length, 0);
});

test("a bad configuration rejects like setup and leaves nothing behind", async () => {
  const r = rig();
  await assert.rejects(setupContentScriptWith({ startupSummary: false }, r.deps), {
    code: "NO_SERVICE_NAME",
  });
  assert.ok(r.log.includes("shutdown"));
  await withContent(rig(), BASE, async () => {});
});

test("without the extension API setupContentScript rejects", async () => {
  const r = rig();
  await assert.rejects(setupContentScriptWith(BASE, { ...r.deps, chrome: undefined }), /chrome/);
});
