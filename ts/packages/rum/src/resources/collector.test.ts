import assert from "node:assert/strict";
import { test } from "node:test";
import { TraceFlags } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { type FakeRuntime, fakeRuntime } from "../test-support/fake-runtime.ts";
import {
  RESOURCE_APP_LOAD_WAIT_MILLIS,
  type ResourceEntryLike,
  type ResourcesEnv,
  resourcesWith,
  resourceType,
} from "./collector.ts";

const APP_LOAD = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: TraceFlags.SAMPLED };
const VIEW_SPAN = { traceId: "c".repeat(32), spanId: "d".repeat(16), traceFlags: TraceFlags.SAMPLED };

interface TestEnv extends ResourcesEnv {
  emit(entries: readonly ResourceEntryLike[]): void;
  observers: number;
}

function env(rt: FakeRuntime, opts: { buffered?: ResourceEntryLike[]; loadEventEnd?: number } = {}): TestEnv {
  const fake = rt.fakeEnv();
  const listeners = new Set<(e: readonly ResourceEntryLike[]) => void>();
  const e: TestEnv = {
    timeOrigin: fake.timeOrigin,
    observe(cb) {
      listeners.add(cb);
      e.observers++;
      cb(opts.buffered ?? []);
      return () => {
        listeners.delete(cb);
        e.observers--;
      };
    },
    loadEventEnd: () => opts.loadEventEnd ?? 500,
    ignore: (u) => u.includes("/_o11y/"),
    setTimeout: (cb, ms) => fake.setTimeout(cb, ms),
    clearTimeout: (h) => fake.clearTimeout(h),
    emit(entries) {
      for (const l of [...listeners]) l(entries);
    },
    observers: 0,
  };
  return e;
}

async function resourceSpans(rt: FakeRuntime): Promise<ReadableSpan[]> {
  await rt.flushSpans();
  return rt.exporter.getFinishedSpans().filter((s) => s.name.startsWith("resource "));
}

function started(): FakeRuntime {
  const rt = fakeRuntime({ realViews: true });
  rt.views.begin();
  rt.views.appLoadStarted(APP_LOAD);
  return rt;
}

test("static resources become spans; requests with their own spans, the gateway and non-HTTP URLs are skipped", async () => {
  const rt = started();
  rt.t = 2000;
  const stop = resourcesWith(
    {},
    env(rt, {
      buffered: [
        {
          name: "https://app.test/main.js?v=3",
          initiatorType: "script",
          startTime: 10,
          responseEnd: 90,
          encodedBodySize: 2048,
          responseStatus: 200,
        },
        { name: "https://app.test/api", initiatorType: "fetch", startTime: 20, responseEnd: 30 },
        { name: "https://app.test/api2", initiatorType: "xmlhttprequest", startTime: 20, responseEnd: 30 },
        { name: "https://app.test/b", initiatorType: "beacon", startTime: 20, responseEnd: 30 },
        { name: "https://app.test/_o11y/v1/traces", initiatorType: "other", startTime: 20, responseEnd: 30 },
        { name: "data:image/png;base64,AAAA", initiatorType: "img", startTime: 20, responseEnd: 30 },
        { name: "https://cdn.test/hero.png", initiatorType: "img", startTime: 900, responseEnd: 1300 },
      ],
    }),
  ).start(rt);
  stop();
  const got = await resourceSpans(rt);
  assert.deepEqual(
    got.map((s) => s.name),
    ["resource script", "resource image"],
  );
  const [script, image] = got;
  assert.equal(script?.attributes["o11y.rum.resource.type"], "script");
  assert.equal(script?.attributes["url.full"], "https://app.test/main.js");
  assert.equal(script?.attributes["server.address"], "app.test");
  assert.equal(script?.attributes["http.response.body.size"], 2048);
  assert.equal(script?.attributes["http.response.status_code"], 200);
  assert.equal(image?.attributes["http.response.status_code"], undefined);
  assert.equal(image?.attributes["http.response.body.size"], undefined);
  assert.equal(script?.attributes["session.id"], "s1");
  assert.equal(script?.attributes["o11y.rum.view.id"], rt.views.loadView()?.id);
  const origin = rt.fakeEnv().timeOrigin;
  assert.equal(script?.startTime[0] * 1000 + script.startTime[1] / 1e6, origin + 10);
  assert.equal(script?.endTime[0] * 1000 + script.endTime[1] / 1e6, origin + 90);
});

test("a resource that started during the load is a child of app_load; a later one is a root linked to its view", async () => {
  const rt = started();
  const view = rt.views.current();
  assert.ok(view);
  rt.views.attachSpan(view.id, VIEW_SPAN);
  const e = env(rt);
  resourcesWith({}, e).start(rt);
  e.emit([
    { name: "https://app.test/a.css", initiatorType: "link", startTime: 100, responseEnd: 200 },
    { name: "https://app.test/late.png", initiatorType: "img", startTime: 700, responseEnd: 800 },
  ]);
  const [css, late] = await resourceSpans(rt);
  assert.equal(css?.parentSpanContext?.spanId, APP_LOAD.spanId);
  assert.deepEqual(css?.links, []);
  assert.equal(late?.parentSpanContext, undefined);
  assert.deepEqual(
    late?.links.map((l) => l.context.spanId),
    [VIEW_SPAN.spanId],
  );
});

test("while the load is under way every resource waits for app_load and then becomes its child", async () => {
  const rt = fakeRuntime({ realViews: true });
  rt.views.begin();
  const e = env(rt, { loadEventEnd: 0 });
  resourcesWith({}, e).start(rt);
  e.emit([{ name: "https://app.test/a.js", initiatorType: "script", startTime: 100, responseEnd: 200 }]);
  assert.equal((await resourceSpans(rt)).length, 0, "held until app_load is known");
  rt.views.appLoadStarted(APP_LOAD);
  rt.fakeEnv().advance(100);
  const [js] = await resourceSpans(rt);
  assert.equal(js?.parentSpanContext?.spanId, APP_LOAD.spanId);
});

test("load resources become roots when app_load never comes", async () => {
  const rt = fakeRuntime({ realViews: true });
  rt.views.begin();
  const e = env(rt, { loadEventEnd: 500 });
  resourcesWith({}, e).start(rt);
  e.emit([{ name: "https://app.test/a.js", initiatorType: "script", startTime: 100, responseEnd: 200 }]);
  rt.fakeEnv().advance(RESOURCE_APP_LOAD_WAIT_MILLIS + 100);
  const [js] = await resourceSpans(rt);
  assert.equal(js?.name, "resource script");
  assert.equal(js?.parentSpanContext, undefined);
});

test("stopping drops held load resources and stops observing", async () => {
  const rt = fakeRuntime({ realViews: true });
  rt.views.begin();
  const e = env(rt, { loadEventEnd: 0 });
  const stop = resourcesWith({}, e).start(rt);
  e.emit([{ name: "https://app.test/a.js", initiatorType: "script", startTime: 100, responseEnd: 200 }]);
  stop();
  rt.views.appLoadStarted(APP_LOAD);
  rt.fakeEnv().advance(RESOURCE_APP_LOAD_WAIT_MILLIS * 2);
  assert.equal((await resourceSpans(rt)).length, 0);
  assert.equal(e.observers, 0);
});

test("Server-Timing: traceparent links to the server span, other entries become server_timing events", async () => {
  const rt = started();
  const e = env(rt);
  resourcesWith({}, e).start(rt);
  e.emit([
    {
      name: "https://app.test/hero.png",
      initiatorType: "img",
      startTime: 900,
      responseEnd: 950,
      serverTiming: [
        {
          name: "traceparent",
          duration: 0,
          description: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        },
        { name: "db", duration: 12, description: "" },
        { name: "cache", duration: 1.5, description: "" },
      ],
    },
  ]);
  const [img] = await resourceSpans(rt);
  assert.ok(img?.links.some((l) => l.context.spanId === "b7ad6b7169203331"));
  assert.deepEqual(
    img?.events.map((ev) => [
      ev.name,
      ev.attributes?.["o11y.rum.server_timing.name"],
      ev.attributes?.["o11y.rum.server_timing.duration"],
    ]),
    [
      ["server_timing", "db", 0.012],
      ["server_timing", "cache", 0.0015],
    ],
  );
  assert.deepEqual(img?.events[0]?.time, img?.startTime);
});

test("at most maxPerView spans per view", async () => {
  const rt = started();
  const many = Array.from({ length: 5 }, (_, i) => ({
    name: `https://app.test/${i}.css`,
    initiatorType: "css",
    startTime: 600 + i,
    responseEnd: 700 + i,
  }));
  const e = env(rt, { buffered: many });
  resourcesWith({ maxPerView: 3 }, e).start(rt);
  assert.equal((await resourceSpans(rt)).length, 3);
  rt.views.start({ kind: "soft", name: "/next" });
  e.emit([{ name: "https://app.test/next.js", initiatorType: "script", startTime: 900, responseEnd: 950 }]);
  assert.equal((await resourceSpans(rt)).length, 4, "a new view has its own allowance");
});

test("a restart after consent is granted again does not replay the buffered entries", async () => {
  const rt = started();
  rt.t = 1000;
  const buffered = [
    { name: "https://app.test/a.js", initiatorType: "script", startTime: 100, responseEnd: 200 },
  ];
  const c = resourcesWith({}, env(rt, { buffered }));
  c.start(rt)();
  c.start(rt);
  assert.equal((await resourceSpans(rt)).length, 1);
});

test("nothing is recorded while consent is not granted", async () => {
  const rt = started();
  rt.gate.open = false;
  const e = env(rt);
  resourcesWith({}, e).start(rt);
  e.emit([{ name: "https://app.test/late.png", initiatorType: "img", startTime: 700, responseEnd: 800 }]);
  assert.equal((await resourceSpans(rt)).length, 0);
});

test("resource types come from the initiator type, with fonts and images loaded by CSS told apart by extension", () => {
  const t = (initiatorType: string, url = "https://app.test/x"): string =>
    resourceType({ name: url, initiatorType });
  assert.equal(t("script"), "script");
  assert.equal(t("css"), "stylesheet");
  assert.equal(t("link"), "stylesheet");
  assert.equal(t("img"), "image");
  assert.equal(t("image"), "image");
  assert.equal(t("input"), "image");
  assert.equal(t("video"), "media");
  assert.equal(t("audio"), "media");
  assert.equal(t("track"), "media");
  assert.equal(t("iframe"), "document");
  assert.equal(t("frame"), "document");
  assert.equal(t("navigation"), "other");
  assert.equal(t("css", "https://app.test/f/inter.woff2?v=1"), "font");
  assert.equal(t("link", "https://app.test/f/inter.ttf"), "font");
  assert.equal(t("other", "https://app.test/f/inter.otf"), "font");
  assert.equal(t("css", "https://app.test/bg.webp"), "image");
  assert.equal(t("link", "https://app.test/app.js"), "script");
  assert.equal(t("img", "https://app.test/font.woff"), "image");
});
