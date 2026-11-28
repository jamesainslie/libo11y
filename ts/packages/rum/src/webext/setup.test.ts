import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { O11yError } from "@libo11y/core";
import { createMemoryQueue, defaultSetupDeps, type HttpTransportOptions } from "@libo11y/web/internal";
import { defaultContentDeps, defaultWorkerDeps } from "@libo11y/webext/internal";
import { CONSENT_STORAGE_KEY } from "../../../webext/src/consent-sync.ts";
import { type ExportMessage, isExportMessage } from "../../../webext/src/protocol.ts";
import { createFakeExtension, type FakeExtension } from "../../../webext/src/test-support/fake-chrome.ts";
import { installRumBootstrapOn, takeBootstrap } from "../bootstrap/buffer.ts";
import { CONFIG_STORAGE_KEY, remoteConfig } from "../config/remote.ts";
import type { CollectorName, RumRuntime } from "../contracts/runtime.ts";
import { errorsWith } from "../errors/collector.ts";
import { longAnimationFrames } from "../loaf.ts";
import { resources } from "../resources/collector.ts";
import { SESSION_STORAGE_KEY } from "../session/local-store.ts";
import { runtimeOf } from "../setup.ts";
import { createFakeStorage } from "../test-support/fake-storage.ts";
import { views } from "../views/collector.ts";
import { vitals } from "../vitals/collector.ts";
import { contentScope, errorSourceUrl } from "./scope.ts";
import { allowRumSessionInContentScripts } from "./session-store.ts";
import {
  type RumExtensionDeps,
  type RumExtensionOptions,
  type RumExtensionTelemetry,
  setupRumExtensionWith,
  setupRumWorkerWith,
} from "./setup.ts";

const EXT_ID = "fakeextensionid";
const BASE_URL = `chrome-extension://${EXT_ID}/`;

class FakeDocument extends EventTarget {
  visibilityState: "visible" | "hidden" = "visible";
  hide(): void {
    this.visibilityState = "hidden";
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

/** A worker context that accepts every export batch, as setupWorker would, and keeps it. */
function fakeWorker(ext: FakeExtension): ExportMessage[] {
  const received: ExportMessage[] = [];
  ext.context({ url: `${BASE_URL}worker.js` }).chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (!isExportMessage(m)) return undefined;
    received.push(m);
    reply({ libo11y: 1, type: "export-reply", ok: true });
    return undefined;
  });
  return received;
}

interface Rig {
  readonly deps: RumExtensionDeps;
  readonly document: FakeDocument;
  readonly window: EventTarget;
  readonly localStorage: ReturnType<typeof createFakeStorage>;
  readonly retentionOpened: string[];
}

function rig(
  ext: FakeExtension,
  context: "page" | "content",
  extra: Partial<RumExtensionDeps["rum"]> = {},
): Rig {
  const page = context === "page";
  const ctx = page
    ? ext.context({ url: `${BASE_URL}panel.html` })
    : ext.context({ tabId: 3, url: "https://host.test/doc/1?q=secret" });
  const document = new FakeDocument();
  const window = new EventTarget();
  const localStorage = createFakeStorage();
  const retentionOpened: string[] = [];
  const location = page ? `${BASE_URL}panel.html` : "https://host.test/doc/1?q=secret";
  return {
    document,
    window,
    localStorage,
    retentionOpened,
    deps: {
      chrome: ctx.chrome,
      install: false,
      content: {
        ...defaultContentDeps(),
        chrome: ctx.chrome,
        installFetchInstrumentation: () => () => {},
        installXhrInstrumentation: () => () => {},
        recordDocumentLoad: async () => {},
        document,
        window,
        location: { protocol: new URL(location).protocol },
      },
      rum: {
        web: defaultSetupDeps(),
        openRetentionQueue: async (o) => {
          retentionOpened.push("indexeddb");
          return createMemoryQueue(o);
        },
        sessionStore: () => {
          throw new Error("setupRumExtension replaces the session store");
        },
        now: Date.now,
        perfNow: () => performance.now(),
        location: () => location,
        prerendered: () => false,
        connection: () => undefined,
        document,
        window,
        storage: () => localStorage,
        fetch: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
        ...extra,
      },
    },
  };
}

const OPTS = {
  serviceName: "rum-ext-test",
  serviceVersion: "1.0.0",
  environment: "test",
  startupSummary: false,
  runtimeMetrics: false,
} as const;

const open: RumExtensionTelemetry[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.shutdown();
});

async function start(options: RumExtensionOptions, deps: RumExtensionDeps): Promise<RumExtensionTelemetry> {
  const t = await setupRumExtensionWith(options, deps);
  open.push(t);
  return t;
}

type OtlpAttr = { key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number } };
const attrs = (list: OtlpAttr[]): Record<string, unknown> =>
  Object.fromEntries(
    list.map((a) => [a.key, a.value.stringValue ?? a.value.doubleValue ?? a.value.intValue]),
  );

function logs(received: readonly ExportMessage[]): Record<string, unknown>[] {
  return received
    .filter((m) => m.signal === "logs")
    .flatMap((m) => {
      const body = JSON.parse(m.body) as {
        resourceLogs: { scopeLogs: { logRecords: { attributes: OtlpAttr[] }[] }[] }[];
      };
      return body.resourceLogs.flatMap((rl) =>
        rl.scopeLogs.flatMap((sl) => sl.logRecords.map((r) => attrs(r.attributes))),
      );
    });
}

function spans(received: readonly ExportMessage[]): { name: string; attributes: Record<string, unknown> }[] {
  return received
    .filter((m) => m.signal === "traces")
    .flatMap((m) => {
      const body = JSON.parse(m.body) as {
        resourceSpans: { scopeSpans: { spans: { name: string; attributes: OtlpAttr[] }[] }[] }[];
      };
      return body.resourceSpans.flatMap((rs) =>
        rs.scopeSpans.flatMap((ss) =>
          ss.spans.map((s) => ({ name: s.name, attributes: attrs(s.attributes) })),
        ),
      );
    });
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function named(name: CollectorName) {
  return { name, start: () => () => {} };
}

test("a content script refuses collectors that would measure the host page", async () => {
  for (const collector of [vitals(), resources(), longAnimationFrames()]) {
    const ext = createFakeExtension(EXT_ID);
    await assert.rejects(
      setupRumExtensionWith(
        { ...OPTS, context: "content", rum: { collectors: [collector] } },
        rig(ext, "content").deps,
      ),
      (err: unknown) =>
        err instanceof O11yError && err.code === "INVALID_OPTION" && err.message.includes(collector.name),
    );
  }
});

test("an extension page may run the collectors a content script refuses", async () => {
  const ext = createFakeExtension(EXT_ID);
  const t = await start(
    { ...OPTS, context: "page", rum: { collectors: [named("vitals"), named("resources")] } },
    rig(ext, "page").deps,
  );
  assert.ok(t.rum);
});

test("a content script refuses documentLoad, which would record the host page's load", async () => {
  const ext = createFakeExtension(EXT_ID);
  await assert.rejects(
    setupRumExtensionWith(
      { ...OPTS, context: "content", instrumentations: { documentLoad: true } },
      rig(ext, "content").deps,
    ),
    (err: unknown) => err instanceof O11yError && err.code === "INVALID_OPTION",
  );
});

test("setupRumExtension needs the extension API", async () => {
  const ext = createFakeExtension(EXT_ID);
  const r = rig(ext, "page");
  await assert.rejects(setupRumExtensionWith({ ...OPTS, context: "page" }, { ...r.deps, chrome: undefined }));
});

test("a content script's view is named content-script, its span carries only the host's domain, and its summary is webext", async () => {
  const ext = createFakeExtension(EXT_ID);
  ext.stored.set(CONSENT_STORAGE_KEY, "granted");
  const received = fakeWorker(ext);
  const r = rig(ext, "content");
  const t = await start({ ...OPTS, context: "content", rum: { collectors: [views()] } }, r.deps);
  assert.ok(t.rum.sessionId());
  assert.equal(runtimeOf(t)?.views.current()?.name, "content-script");
  await new Promise((resolve) => setTimeout(resolve, 50));
  r.document.hide();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await t.forceFlush();
  await ext.settle();
  const summary = logs(received).find((l) => l["event.name"] === "o11y.rum.view.summary");
  assert.equal(summary?.["o11y.rum.platform"], "webext");
  assert.equal(summary?.["o11y.rum.view.name"], "content-script");
  assert.equal(summary?.["o11y.rum.view.kind"], "initial");
  const view = spans(received).find((s) => s.name.startsWith("view "));
  assert.equal(view?.name, "view content-script");
  assert.equal(view?.attributes["url.domain"], "host.test");
  assert.equal(view?.attributes["o11y.rum.platform"], "webext");
  for (const s of spans(received)) {
    assert.equal(s.attributes["url.full"], undefined, s.name);
    assert.equal(s.attributes["url.path"], undefined, s.name);
  }
});

test("a content script's view name can be set, and the host page's URL changes never rename it", async () => {
  const ext = createFakeExtension(EXT_ID);
  ext.stored.set(CONSENT_STORAGE_KEY, "granted");
  fakeWorker(ext);
  const r = rig(ext, "content");
  const t = await start(
    { ...OPTS, context: "content", content: { viewName: "capture-overlay" }, rum: { collectors: [views()] } },
    r.deps,
  );
  t.rum.startView();
  assert.equal(runtimeOf(t)?.views.current()?.name, "capture-overlay");
});

test("an extension page and a content script share one session", async () => {
  const ext = createFakeExtension(EXT_ID);
  ext.stored.set(CONSENT_STORAGE_KEY, "granted");
  fakeWorker(ext);
  await allowRumSessionInContentScripts(ext.context({ url: `${BASE_URL}worker.js` }).chrome);
  const page = await start({ ...OPTS, context: "page" }, rig(ext, "page").deps);
  await ext.settle();
  const content = await start({ ...OPTS, context: "content" }, rig(ext, "content").deps);
  assert.ok(page.rum.sessionId());
  assert.equal(content.rum.sessionId(), page.rum.sessionId());
  assert.ok(ext.sessionStored.has(SESSION_STORAGE_KEY));
});

test("an extension page names its view from its own URL and keeps its retention buffer in IndexedDB", async () => {
  const ext = createFakeExtension(EXT_ID);
  ext.stored.set(CONSENT_STORAGE_KEY, "granted");
  const received = fakeWorker(ext);
  const r = rig(ext, "page");
  const t = await start({ ...OPTS, context: "page", rum: { sessionSampleRate: 0 } }, r.deps);
  assert.equal(runtimeOf(t)?.views.current()?.name, "/panel.html");
  t.tracerProvider.getTracer("app").startSpan("work").end();
  await t.forceFlush();
  await until(() => r.retentionOpened.length > 0, "the retention buffer");
  assert.deepEqual(r.retentionOpened, ["indexeddb"]);
  assert.deepEqual(spans(received), [], "an unkept session buffers its detail");
});

test("a content script keeps its retention buffer in memory, never in the host page's IndexedDB", async () => {
  const ext = createFakeExtension(EXT_ID);
  ext.stored.set(CONSENT_STORAGE_KEY, "granted");
  fakeWorker(ext);
  const r = rig(ext, "content");
  const t = await start({ ...OPTS, context: "content", rum: { sessionSampleRate: 0 } }, r.deps);
  t.tracerProvider.getTracer("app").startSpan("work").end();
  await t.forceFlush();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(r.retentionOpened, []);
});

test("a content script records only errors from the extension's own scripts", async () => {
  const ext = createFakeExtension(EXT_ID);
  ext.stored.set(CONSENT_STORAGE_KEY, "granted");
  const received = fakeWorker(ext);
  const r = rig(ext, "content");
  const t = await start(
    { ...OPTS, context: "content", rum: { collectors: [errorsWith({}, { window: r.window })] } },
    r.deps,
  );
  const fire = (filename: string, message: string): void => {
    const e = new Event("error");
    Object.defineProperties(e, { error: { value: new Error(message) }, filename: { value: filename } });
    r.window.dispatchEvent(e);
  };
  fire("https://host.test/app.js", "host");
  fire(`${BASE_URL}content.js`, "mine");
  await t.forceFlush();
  await ext.settle();
  const messages = logs(received)
    .filter((l) => l["event.name"] === "o11y.rum.error")
    .map((l) => l["exception.message"]);
  assert.deepEqual(messages, ["mine"]);
});

test("the content scope accepts actions only inside the UI root, and errors only from the extension", () => {
  const root = { id: "root" };
  const inside = { composedPath: () => [{}, root, {}] } as unknown as Event;
  const outside = { composedPath: () => [{}, {}] } as unknown as Event;
  const scope = contentScope({ base: BASE_URL, uiRoot: root as unknown as Node, host: "host.test" });
  assert.equal(scope.action?.(inside), true);
  assert.equal(scope.action?.(outside), false);
  assert.equal(
    contentScope({ base: BASE_URL, host: "host.test" }).action?.(inside),
    false,
    "no UI root, no actions",
  );
  assert.equal(scope.fixedView, true);
  assert.deepEqual(scope.viewAttributes, { "url.domain": "host.test" });
  const rejection = (stack: string): Event =>
    ({ type: "unhandledrejection", target: null, reason: { stack } }) as unknown as Event;
  assert.equal(scope.error?.(rejection(`Error: x\n    at f (${BASE_URL}content.js:1:2)`)), true);
  assert.equal(scope.error?.(rejection("Error: x\n    at f (https://host.test/app.js:1:2)")), false);
  assert.equal(scope.error?.({ type: "unhandledrejection", reason: "plain" } as unknown as Event), false);
  const resource = (src: string): Event =>
    ({ type: "error", target: { tagName: "IMG", src } }) as unknown as Event;
  assert.equal(scope.error?.(resource(`${BASE_URL}icon.png`)), true);
  assert.equal(scope.error?.(resource("https://host.test/a.png")), false);
  const csp = { type: "securitypolicyviolation", sourceFile: "https://host.test/app.js" } as unknown as Event;
  assert.equal(errorSourceUrl(csp), "https://host.test/app.js");
  assert.equal(scope.error?.(csp), false);
});

test("remote configuration works in an extension context and caches in chrome.storage.local", async () => {
  const ext = createFakeExtension(EXT_ID);
  ext.stored.set(CONSENT_STORAGE_KEY, "granted");
  fakeWorker(ext);
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ version: "c1", config: { sessionSampleRate: 0.5 } }), {
      status: 200,
      headers: { ETag: '"c1"' },
    });
  }) as unknown as typeof globalThis.fetch;
  const r = rig(ext, "content", { fetch });
  const t = await start(
    {
      ...OPTS,
      context: "content",
      rum: { clientToken: "tok", remoteConfig: remoteConfig({ url: "https://app.test/_o11y/v1/config" }) },
    },
    r.deps,
  );
  await until(() => ext.stored.has(CONFIG_STORAGE_KEY), "the cached document");
  const url = new URL(urls[0] ?? "");
  assert.equal(url.origin + url.pathname, "https://app.test/_o11y/v1/config");
  assert.equal(url.searchParams.get("service"), "rum-ext-test");
  assert.equal(url.searchParams.get("client_token"), "tok");
  assert.equal(r.localStorage.items.size, 0, "nothing goes to the host page's localStorage");
  // Another context that starts a new session takes the cached document before any fetch answers.
  ext.sessionStored.delete(SESSION_STORAGE_KEY);
  const page = rig(ext, "page", {
    fetch: (() => new Promise(() => {})) as unknown as typeof globalThis.fetch,
  });
  const p = await start(
    {
      ...OPTS,
      context: "page",
      rum: {
        remoteConfig: remoteConfig({
          url: "https://app.test/_o11y/v1/config",
          limits: { sessionSampleRate: [0, 1] },
        }),
      },
    },
    page.deps,
  );
  assert.equal(runtimeOf(p)?.session.current()?.configVersion, "c1");
  assert.equal(runtimeOf(p)?.settings().sessionSampleRate, 0.5);
  await t.consent.revoke();
  await until(() => !ext.stored.has(CONFIG_STORAGE_KEY), "the cache removed on revoke");
});

test("setupRumWorker sends with the gateway's wire parameters and opens the session to content scripts", async () => {
  const ext = createFakeExtension(EXT_ID);
  const worker = ext.context({ url: `${BASE_URL}worker.js` });
  const seen: HttpTransportOptions[] = [];
  const posted: string[] = [];
  const t = await setupRumWorkerWith(
    {
      ...OPTS,
      endpoint: "https://app.test/_o11y",
      consent: { initial: "granted" },
      rum: { clientToken: "tok" },
    },
    {
      worker: {
        ...defaultWorkerDeps(),
        chrome: worker.chrome,
        openQueue: async (o) => createMemoryQueue(o),
        createHttpTransport: (o) => {
          seen.push(o);
          return { send: async () => ({ kind: "ok" }) };
        },
      },
      fetch: (async (url: string) => {
        posted.push(String(url));
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
      now: () => 1234,
    },
  );
  try {
    await seen[0]?.fetch?.("https://app.test/_o11y/v1/traces", { method: "POST" });
    const u = new URL(posted[0] ?? "");
    assert.equal(u.pathname, "/_o11y/v1/traces");
    assert.equal(u.searchParams.get("client_token"), "tok");
    assert.equal(u.searchParams.get("sent_at"), "1234");
    assert.equal(seen[0]?.sendBeacon, undefined, "a worker has no sendBeacon");
    await ext.settle();
    // The worker opened chrome.storage.session to content scripts.
    assert.deepEqual(await ext.context({ tabId: 9 }).chrome.storage?.session.get("probe"), {});
  } finally {
    await t.shutdown();
  }
});

test("remote configuration in an extension needs an absolute URL", async () => {
  for (const rc of [remoteConfig(), remoteConfig({ url: "/_o11y/v1/config" })]) {
    const ext = createFakeExtension(EXT_ID);
    await assert.rejects(
      setupRumExtensionWith({ ...OPTS, context: "page", rum: { remoteConfig: rc } }, rig(ext, "page").deps),
      (err: unknown) => err instanceof O11yError && err.code === "INVALID_OPTION",
    );
  }
});

test("a revoke while the configuration cache loads still removes the cache", async () => {
  const ext = createFakeExtension(EXT_ID);
  ext.stored.set(CONFIG_STORAGE_KEY, JSON.stringify({ body: { version: "old", config: {} } }));
  fakeWorker(ext);
  const r = rig(ext, "page", { fetch: (() => new Promise(() => {})) as unknown as typeof globalThis.fetch });
  const t = await start(
    {
      ...OPTS,
      context: "page",
      rum: { remoteConfig: remoteConfig({ url: "https://app.test/_o11y/v1/config" }) },
    },
    r.deps,
  );
  t.consent.grant();
  await t.consent.revoke();
  await until(() => !ext.stored.has(CONFIG_STORAGE_KEY), "the cache removed");
  assert.equal(t.rum.sessionId(), undefined);
});

test("an error whose message holds a URL is judged by its stack frames, not the message", () => {
  const scope = contentScope({ base: BASE_URL, host: "host.test" });
  const rejection = (stack: string): Event =>
    ({ type: "unhandledrejection", target: null, reason: { stack } }) as unknown as Event;
  // V8 frames.
  assert.equal(
    scope.error?.(
      rejection(`Error: GET https://api.example.com/x failed\n    at load (${BASE_URL}content.js:3:9)`),
    ),
    true,
  );
  assert.equal(
    scope.error?.(rejection(`Error: see ${BASE_URL}help\n    at main (https://host.test/app.js:1:2)`)),
    false,
  );
  // Firefox frames.
  assert.equal(scope.error?.(rejection(`load@moz-extension://uuid/content.js:3:9\n`)), false);
  assert.equal(
    contentScope({ base: "moz-extension://uuid/", host: "host.test" }).error?.(
      rejection("load@moz-extension://uuid/content.js:3:9\n"),
    ),
    true,
  );
  const uncaught = {
    type: "error",
    target: null,
    filename: "",
    error: { stack: `TypeError: bad https://x.test/\n    at f (${BASE_URL}content.js:1:1)` },
  } as unknown as Event;
  assert.equal(errorSourceUrl(uncaught), `${BASE_URL}content.js:1:1`);
});

test("two extension contexts that create the first session at once send one session.start", async () => {
  const ext = createFakeExtension(EXT_ID);
  ext.stored.set(CONSENT_STORAGE_KEY, "granted");
  const received = fakeWorker(ext);
  const [a, b] = await Promise.all([
    start({ ...OPTS, context: "page" }, rig(ext, "page").deps),
    start({ ...OPTS, context: "page" }, rig(ext, "page").deps),
  ]);
  await until(
    () => a.rum.sessionId() !== undefined && a.rum.sessionId() === b.rum.sessionId(),
    "the contexts to agree on a session",
  );
  await new Promise((r) => setTimeout(r, 700));
  await Promise.all([a.forceFlush(), b.forceFlush()]);
  await ext.settle();
  const starts = logs(received).filter((l) => l["event.name"] === "o11y.rum.session.start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.["session.id"], a.rum.sessionId());
});

test("a content script discards what a bootstrap in its world buffered", async () => {
  const ext = createFakeExtension(EXT_ID);
  ext.stored.set(CONSENT_STORAGE_KEY, "granted");
  fakeWorker(ext);
  const target = new EventTarget();
  installRumBootstrapOn(
    target,
    { consent: "granted" },
    { now: () => performance.now(), setTimeout: () => 0 },
  );
  const e = new Event("error");
  Object.defineProperty(e, "error", { value: new Error("host page") });
  target.dispatchEvent(e);
  const replayed: string[] = [];
  const recorder = {
    name: "errors" as const,
    start: (rt: RumRuntime) =>
      rt.bus.subscribe((s) => {
        if (s.type === "bootstrap") replayed.push(s.entry.kind);
      }),
  };
  await start({ ...OPTS, context: "content", rum: { collectors: [recorder] } }, rig(ext, "content").deps);
  assert.deepEqual(replayed, []);
  assert.equal(takeBootstrap(), undefined, "the buffer was taken and dropped");
});
