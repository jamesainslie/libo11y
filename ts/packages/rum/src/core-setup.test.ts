/**
 * setupRumCore over a platform that is not a page: a binding of its own, a lifecycle with no
 * document or window, and no localStorage. The web wiring over it is setup.test.ts.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { WebSetupOptions, WebTelemetry } from "@libo11y/web";
import { createMemoryQueue, defaultSetupDeps, type SetupDeps } from "@libo11y/web/internal";
import { createFakeTransport, type FakeTransport } from "../../web/src/test-support/index.ts";
import { webBinding } from "./bind.ts";
import type { RumLifecycle, RumLifecycleHandlers } from "./contracts/binding.ts";
import { type RumCoreDeps, runtimeOf, setupRumCore } from "./core-setup.ts";
import type { RumOptions } from "./options.ts";
import { localStorageSessionStore } from "./session/local-store.ts";
import { createChannelHub, createFakeStorage } from "./test-support/fake-storage.ts";

/** A lifecycle the test drives, as an app's foreground and background would. */
interface FakeLifecycle extends RumLifecycle {
  emit(event: keyof RumLifecycleHandlers): void;
  touch(): void;
  listeners(): number;
  setVisible(v: boolean): void;
}

function fakeLifecycle(): FakeLifecycle {
  let shown = true;
  const subs = new Set<RumLifecycleHandlers>();
  const active = new Set<() => void>();
  return {
    visible: () => shown,
    subscribe(handlers) {
      subs.add(handlers);
      return () => subs.delete(handlers);
    },
    activity(listener) {
      active.add(listener);
      return () => active.delete(listener);
    },
    emit(e) {
      if (e === "hide") shown = false;
      if (e === "show") shown = true;
      for (const h of [...subs]) h[e]();
    },
    touch() {
      for (const l of [...active]) l();
    },
    listeners: () => subs.size + active.size,
    setVisible(v) {
      shown = v;
    },
  };
}

interface Harness {
  readonly transport: FakeTransport;
  readonly lifecycle: FakeLifecycle;
  /** The event names emitted when the platform's own hide listener ran. */
  readonly atPlatformHide: string[][];
  readonly deps: RumCoreDeps<WebSetupOptions, WebTelemetry>;
}

function harness(platform: "react_native" | "web" = "react_native"): Harness {
  const transport = createFakeTransport();
  const storage = createFakeStorage();
  const hub = createChannelHub();
  const lifecycle = fakeLifecycle();
  const atPlatformHide: string[][] = [];
  const web: SetupDeps = {
    ...defaultSetupDeps(),
    openQueue: async (o) => createMemoryQueue(o),
    createHttpTransport: () => transport,
    installFetchInstrumentation: () => () => {},
    installXhrInstrumentation: () => () => {},
    recordDocumentLoad: async () => {},
    document: undefined,
    window: undefined,
  };
  const bindWeb = webBinding(web, false);
  return {
    transport,
    lifecycle,
    atPlatformHide,
    deps: {
      platform,
      // The platform's own flush on hide subscribes inside bind, after RUM did.
      bind: async (options, wrappers) => {
        const t = await bindWeb(options, wrappers);
        const emitted: string[] = [];
        const event = t.event.bind(t);
        t.event = (name, ...rest) => {
          emitted.push(name);
          event(name, ...rest);
        };
        lifecycle.subscribe({
          hide: () => atPlatformHide.push([...emitted]),
          show: () => {},
          restore: () => {},
        });
        return t;
      },
      lifecycle,
      openRetentionQueue: async (o) => createMemoryQueue(o),
      sessionStore: () => localStorageSessionStore({ storage, channel: hub.channel() }),
      now: Date.now,
      perfNow: () => performance.now(),
      location: () => "app:///",
      prerendered: () => false,
      connection: () => undefined,
    },
  };
}

const OPTS: WebSetupOptions = {
  serviceName: "rum-core-test",
  serviceVersion: "1.0.0",
  environment: "test",
  endpoint: "https://gateway.test/_o11y",
  runtimeMetrics: false,
  startupSummary: false,
  transport: { compression: "none" },
  consent: { initial: "granted" },
};

const RUM: RumOptions = { viewName: () => "app" };

let open: { shutdown(): Promise<unknown> } | undefined;
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
                a.value.stringValue ?? a.value.doubleValue ?? a.value.intValue,
              ]),
            ),
          ),
        ),
      );
    });
}

test("the binding's platform labels the summaries, with no document, window or localStorage", async () => {
  const h = harness();
  const t = await setupRumCore(OPTS, RUM, h.deps);
  open = t;
  assert.ok(t.rum.sessionId());
  h.lifecycle.emit("hide");
  await t.forceFlush();
  const summary = logRecords(h.transport).find((r) => r["event.name"] === "o11y.rum.view.summary");
  assert.equal(summary?.["o11y.rum.platform"], "react_native");
  assert.equal(summary?.["o11y.rum.view.name"], "app");
});

test("a hide emits the session start and the summaries before the platform's own hide listener runs", async () => {
  const h = harness();
  open = await setupRumCore(OPTS, RUM, h.deps);
  h.lifecycle.emit("hide");
  // A hidden app may never run again, so the session start waiting for its election goes too.
  assert.deepEqual(h.atPlatformHide, [["o11y.rum.session.start", "o11y.rum.view.summary"]]);
});

test("hide hooks run once per hide, every hide signal sends, and show or restore begins the next hide", async () => {
  const h = harness();
  const t = await setupRumCore(OPTS, RUM, h.deps);
  open = t;
  const rt = runtimeOf(t);
  assert.ok(rt);
  let hooks = 0;
  rt.onHide(() => hooks++);
  h.lifecycle.emit("hide");
  h.lifecycle.emit("hide");
  assert.equal(hooks, 1);
  assert.equal(h.atPlatformHide.length, 2);
  h.lifecycle.emit("restore");
  h.lifecycle.emit("hide");
  assert.equal(hooks, 2);
  h.lifecycle.emit("show");
  h.lifecycle.emit("hide");
  assert.equal(hooks, 3);
});

test("time on view stops while hidden and resumes on show", async () => {
  const h = harness();
  const t = await setupRumCore(OPTS, RUM, h.deps);
  open = t;
  h.lifecycle.emit("hide");
  await new Promise((r) => setTimeout(r, 30));
  h.lifecycle.emit("show");
  h.lifecycle.emit("hide");
  await t.forceFlush();
  const times = logRecords(h.transport)
    .filter((r) => r["event.name"] === "o11y.rum.view.summary")
    .map((r) => Number(r["o11y.rum.summary.time_on_view"] ?? 0));
  assert.equal(times.length, 2);
  assert.ok((times[1] ?? Infinity) < 25, `time on view while hidden counted: ${times[1]}`);
});

test("activity the lifecycle reports keeps the session alive", async () => {
  let now = 1_000_000;
  const h = harness();
  const t = await setupRumCore(OPTS, { ...RUM, sessionIdleMillis: 60_000 }, { ...h.deps, now: () => now });
  open = t;
  const id = t.rum.sessionId();
  now += 50_000;
  h.lifecycle.touch();
  now += 50_000;
  assert.equal(runtimeOf(t)?.session.current()?.id, id);
});

test("shutdown removes every lifecycle listener", async () => {
  const h = harness();
  const t = await setupRumCore(OPTS, RUM, h.deps);
  assert.ok(h.lifecycle.listeners() > 0);
  await t.shutdown();
  // The platform's own listener in this harness is not RUM's and stays.
  assert.equal(h.lifecycle.listeners(), 1);
});

test("a binding that fails leaves no lifecycle listener behind", async () => {
  const h = harness();
  await assert.rejects(
    setupRumCore(OPTS, RUM, {
      ...h.deps,
      bind: async () => {
        throw new Error("no platform");
      },
    }),
    /no platform/,
  );
  assert.equal(h.lifecycle.listeners(), 0);
});

test("viewKind gives every view that kind, startView's included, and the first is the load view", async () => {
  const h = harness();
  const t = await setupRumCore(OPTS, RUM, { ...h.deps, viewKind: "screen" });
  open = t;
  const rt = runtimeOf(t);
  const first = rt?.views.current();
  assert.equal(first?.kind, "screen");
  assert.equal(rt?.views.loadView()?.id, first?.id);
  t.rum.startView({ name: "next" });
  assert.equal(rt?.views.current()?.kind, "screen");
  assert.equal(rt?.views.loadView()?.id, first?.id, "a later screen is not the load view");
  h.lifecycle.emit("hide");
  await t.forceFlush();
  const kinds = logRecords(h.transport)
    .filter((r) => r["event.name"] === "o11y.rum.view.summary")
    .map((r) => r["o11y.rum.view.kind"]);
  assert.deepEqual(kinds, ["screen", "screen"]);
});

test("onRuntime gets the runtime before a grant at setup begins the load view", async () => {
  const h = harness();
  const seen: (string | undefined)[] = [];
  const t = await setupRumCore(OPTS, RUM, {
    ...h.deps,
    onRuntime: (rt) => {
      seen.push(rt.views.current()?.id);
      rt.views.subscribe((e) => {
        if (e.type === "start") seen.push(e.view.kind);
      });
    },
  });
  open = t;
  assert.deepEqual(seen, [undefined, "initial"]);
  assert.equal(runtimeOf(t)?.views.current()?.kind, "initial", "the web's kinds without viewKind");
});

test("initialViewStart places the first view where the platform's clock says the app started", async () => {
  const h = harness();
  const t = await setupRumCore(OPTS, RUM, { ...h.deps, perfNow: () => 5000, initialViewStart: () => 4200 });
  open = t;
  assert.equal(runtimeOf(t)?.views.current()?.startTime, 4200);
});
