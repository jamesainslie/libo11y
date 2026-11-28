import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CONFIG_STORAGE_KEY, remoteConfig, runtimeOf, SESSION_STORAGE_KEY } from "@libo11y/rum/core";
import { fakeStorage } from "../../react-native/src/test-support/fake-storage.ts";
import { type Harness, harness } from "./test-support/harness.ts";

let open: Harness | undefined;
afterEach(async () => {
  await open?.telemetry.shutdown();
  open = undefined;
});

async function started(...args: Parameters<typeof harness>): Promise<Harness> {
  open = await harness(...args);
  return open;
}

test("summaries carry react_native, kind screen and the initial view name", async () => {
  const h = await started({ consent: { initial: "granted" }, rum: { initialViewName: "boot" } });
  await h.idle();
  h.app.setAppState("background");
  await h.idle();
  const [s] = h.events("o11y.rum.view.summary");
  assert.equal(s?.["o11y.rum.platform"], "react_native");
  assert.equal(s?.["o11y.rum.view.kind"], "screen");
  assert.equal(s?.["o11y.rum.view.name"], "boot");
  assert.equal(s?.["session.id"], h.telemetry.rum.sessionId());
  const [start] = h.events("o11y.rum.session.start");
  assert.equal(start?.["o11y.rum.platform"], "react_native", "a hide sends the session start");
});

test("every view is a screen, a later startView's too, and the first is the load view", async () => {
  const h = await started({ consent: { initial: "granted" } });
  const rt = runtimeOf(h.telemetry);
  const first = rt?.views.current();
  assert.equal(first?.kind, "screen");
  assert.equal(first?.name, "app");
  h.telemetry.rum.startView({ name: "/settings" });
  assert.equal(rt?.views.current()?.kind, "screen");
  assert.equal(rt?.views.loadView()?.id, first?.id);
  assert.equal(rt?.platform, "react_native");
});

test("pending consent writes nothing to storage; a grant stores the session", async () => {
  const h = await started({ consent: { initial: "pending" } });
  h.telemetry.tracerProvider.getTracer("t").startSpan("work").end();
  h.app.setAppState("background");
  await h.idle();
  assert.equal(h.storage.writes(), 0);
  assert.equal(h.storage.reads(SESSION_STORAGE_KEY), 0);
  assert.deepEqual(h.transport.requests, []);
  h.telemetry.consent.grant();
  await h.idle();
  assert.ok(h.storage.map.has(SESSION_STORAGE_KEY));
  assert.ok(h.telemetry.rum.sessionId());
});

test("a relaunch within the idle window continues the session; after it, a new one starts", async () => {
  const storage = fakeStorage();
  const a = await harness({ consent: { initial: "granted" } }, { storage });
  await a.idle();
  const id = a.telemetry.rum.sessionId();
  assert.ok(id);
  const at = a.clock();
  await a.telemetry.shutdown();
  const b = await harness({ consent: { initial: "granted" } }, { storage, clockStart: at + 60_000 });
  assert.equal(b.telemetry.rum.sessionId(), id);
  await b.telemetry.shutdown();
  const c = await harness(
    { consent: { initial: "granted" } },
    { storage, clockStart: at + 60_000 + 900_001 },
  );
  open = c;
  assert.ok(c.telemetry.rum.sessionId());
  assert.notEqual(c.telemetry.rum.sessionId(), id);
});

test("revoking removes the stored session and the config cache", async () => {
  const storage = fakeStorage();
  storage.map.set(CONFIG_STORAGE_KEY, JSON.stringify({ etag: '"v1"', body: { version: "v1", config: {} } }));
  const h = await started(
    {
      consent: { initial: "granted" },
      rum: { remoteConfig: remoteConfig({ url: "https://gw.test/_o11y/v1/config" }) },
    },
    { storage },
  );
  await h.idle();
  assert.ok(storage.map.has(SESSION_STORAGE_KEY));
  h.telemetry.consent.revoke();
  await h.idle();
  assert.equal(storage.map.has(SESSION_STORAGE_KEY), false);
  assert.equal(storage.map.has(CONFIG_STORAGE_KEY), false);
});

test("an unkept session's detail waits in device storage and an error sends it", async () => {
  // A clock an hour behind the real one: the buffer stamps and claims on the same clock.
  const h = await started(
    { consent: { initial: "granted" }, rum: { sessionSampleRate: 0 } },
    { timeOrigin: Date.now() - 3_600_000 },
  );
  await h.idle();
  h.telemetry.tracerProvider.getTracer("t").startSpan("detail").end();
  await h.idle();
  assert.equal(
    h.spans().some((s) => s.name === "detail"),
    false,
  );
  assert.ok([...h.storage.map.keys()].some((k) => k.startsWith("libo11y/libo11y-rum-retention/")));
  h.telemetry.rum.addError(new Error("boom"));
  for (let i = 0; i < 20 && !h.spans().some((s) => s.name === "detail"); i++) await h.idle();
  assert.ok(h.spans().some((s) => s.name === "detail"));
});

test("the OTLP requests carry sent_at and client_token", async () => {
  const h = await started({ consent: { initial: "granted" }, rum: { clientToken: "pub-fixture" } });
  await h.transportOptions[0]?.fetch?.("https://gw.test/_o11y/v1/traces", { method: "POST" });
  assert.match(
    h.fetched.at(-1) ?? "",
    /^https:\/\/gw\.test\/_o11y\/v1\/traces\?sent_at=\d+&client_token=pub-fixture$/,
  );
});

test("remote configuration reads the device cache on the first grant only, and its kill switch applies at once", async () => {
  const storage = fakeStorage();
  storage.map.set(
    CONFIG_STORAGE_KEY,
    JSON.stringify({ etag: '"v1"', body: { version: "v1", config: { enabled: false } } }),
  );
  const h = await started(
    {
      consent: { initial: "pending" },
      rum: { remoteConfig: remoteConfig({ url: "https://gw.test/_o11y/v1/config" }) },
    },
    { storage },
  );
  await h.idle();
  assert.equal(storage.reads(CONFIG_STORAGE_KEY), 0);
  assert.equal(
    h.fetched.some((u) => u.includes("/v1/config")),
    false,
  );
  h.telemetry.consent.grant();
  await h.idle();
  assert.equal(storage.reads(CONFIG_STORAGE_KEY), 1);
  assert.equal(h.telemetry.rum.sessionId(), undefined, "the cached kill switch applies at once");
  h.app.setAppState("background");
  await h.idle();
  assert.deepEqual(h.events("o11y.rum.session.start"), []);
  assert.ok(h.fetched.some((u) => u.startsWith("https://gw.test/_o11y/v1/config?service=app")));
});

test("app metrics export with delta temporality, as the gateway needs", async () => {
  const h = await started({ consent: { initial: "granted" } });
  h.telemetry.meterProvider.getMeter("t").createCounter("app.taps").add(1);
  await h.idle();
  const taps = h.metrics().find((m) => m.name === "app.taps");
  assert.equal(taps?.temporality, 1, "AGGREGATION_TEMPORALITY_DELTA");
});

test("the resource says react_native and the JavaScript SDK", async () => {
  const h = await started({ consent: { initial: "granted" } });
  assert.equal(h.telemetry.resource.attributes["o11y.rum.platform"], "react_native");
  assert.equal(h.telemetry.resource.attributes["telemetry.sdk.language"], "javascript");
});

test("going to the background flushes the summaries; coming back starts the next one", async () => {
  const h = await started({ consent: { initial: "granted" } });
  h.advance(1000);
  h.app.setAppState("background");
  await h.idle();
  assert.equal(h.events("o11y.rum.view.summary").length, 1);
  h.advance(5000);
  h.app.setAppState("active");
  h.advance(2000);
  h.app.setAppState("background");
  await h.idle();
  const summaries = h.events("o11y.rum.view.summary");
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0]?.["o11y.rum.view.id"], summaries[1]?.["o11y.rum.view.id"]);
});

test("a new screen is activity: navigating keeps the session alive past the idle window", async () => {
  const h = await started({ consent: { initial: "granted" } });
  const id = h.telemetry.rum.sessionId();
  for (let i = 0; i < 16; i++) {
    h.advance(60_000);
    h.telemetry.rum.startView({ name: `/s${i}` });
  }
  assert.equal(h.telemetry.rum.sessionId(), id);
});

test("a revoke in a launch that never granted removes what an earlier launch stored", async () => {
  const storage = fakeStorage();
  const a = await harness(
    {
      consent: { initial: "granted" },
      rum: { sessionSampleRate: 0, remoteConfig: remoteConfig({ url: "https://gw.test/_o11y/v1/config" }) },
    },
    { storage },
  );
  a.telemetry.tracerProvider.getTracer("t").startSpan("detail").end();
  await a.idle();
  storage.map.set(CONFIG_STORAGE_KEY, "{}");
  await a.telemetry.shutdown();
  assert.ok(storage.map.has(SESSION_STORAGE_KEY));
  assert.ok([...storage.map.keys()].some((k) => k.startsWith("libo11y/libo11y-rum-retention/b/")));
  const b = await started({ consent: { initial: "pending" } }, { storage });
  await b.telemetry.consent.revoke();
  assert.equal(storage.map.has(SESSION_STORAGE_KEY), false);
  assert.equal(storage.map.has(CONFIG_STORAGE_KEY), false);
  assert.deepEqual(
    [...storage.map.keys()].filter((k) => k.startsWith("libo11y/libo11y-rum-retention/b/")),
    [],
  );
});
