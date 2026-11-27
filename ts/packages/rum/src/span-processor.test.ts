import assert from "node:assert/strict";
import { test } from "node:test";
import { SpanKind } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { createBus } from "./bus.ts";
import type { RumSignal } from "./contracts/runtime.ts";
import { APP_LOAD_SPAN, rumSpanProcessor } from "./span-processor.ts";

function setup(session: { id: string } | null = { id: "s1" }) {
  const exporter = new InMemorySpanExporter();
  const bus = createBus();
  const signals: RumSignal[] = [];
  bus.subscribe((s) => signals.push(s));
  const appLoads: string[] = [];
  const processor = rumSpanProcessor({
    platform: "web",
    session: {
      current: () =>
        session === null ? undefined : { ...session, startedAt: 0, lastActivityAt: 0, sampled: true },
    },
    views: {
      current: () => ({ id: "v9", name: "/x", kind: "soft", startTime: 0, sessionId: "s1" }),
      loadView: () => ({ id: "v0", name: "/", kind: "initial", startTime: 0, sessionId: "s1" }),
      appLoadStarted: (ctx) => void appLoads.push(ctx.spanId),
    },
    queryAllowList: () => new Set(["page"]),
    userId: () => "u-123",
    bus,
    now: () => 5,
  });
  const tp = new TracerProvider({ spanProcessors: [processor, new SimpleSpanProcessor({ exporter })] });
  return { tp, exporter, signals, appLoads };
}

test("every span gets session.id, the current view and user.id", async () => {
  const { tp, exporter } = setup();
  tp.getTracer("app").startSpan("work").end();
  await tp.forceFlush();
  const [s] = exporter.getFinishedSpans();
  assert.equal(s?.attributes["session.id"], "s1");
  assert.equal(s?.attributes["o11y.rum.view.id"], "v9");
  assert.equal(s?.attributes["user.id"], "u-123");
  assert.equal(s?.attributes["o11y.rum.span.shape"], undefined);
});

test("web's documentLoad becomes the app_load shape of the load view", async () => {
  const { tp, exporter, appLoads } = setup();
  tp.getTracer("@libo11y/web").startSpan("documentLoad").end();
  await tp.forceFlush();
  const [s] = exporter.getFinishedSpans();
  assert.equal(s?.name, APP_LOAD_SPAN);
  assert.equal(s?.attributes["o11y.rum.span.shape"], "app_load");
  assert.equal(s?.attributes["o11y.rum.view.id"], "v0");
  assert.equal(s?.attributes["o11y.rum.platform"], "web");
  assert.deepEqual(appLoads, [s?.spanContext().spanId]);
});

test("a documentLoad span from another scope is left alone", async () => {
  const { tp, exporter } = setup();
  tp.getTracer("app").startSpan("documentLoad").end();
  await tp.forceFlush();
  assert.equal(exporter.getFinishedSpans()[0]?.name, "documentLoad");
});

test("client request spans lose disallowed query parameters and reach the bus", async () => {
  const { tp, exporter, signals } = setup();
  tp.getTracer("@libo11y/web")
    .startSpan("GET", {
      kind: SpanKind.CLIENT,
      attributes: { "http.request.method": "GET", "url.full": "https://api.test/q?page=1&token=t" },
    })
    .end();
  await tp.forceFlush();
  assert.equal(exporter.getFinishedSpans()[0]?.attributes["url.full"], "https://api.test/q?page=1");
  assert.deepEqual(
    signals.map((s) => s.type),
    ["request-start", "request-end", "breadcrumb"],
  );
  const start = signals[0];
  assert.equal(start?.type === "request-start" ? start.url : "", "https://api.test/q?page=1");
});

test("without a session spans are left alone", async () => {
  const { tp, exporter, signals } = setup(null);
  tp.getTracer("@libo11y/web").startSpan("documentLoad").end();
  await tp.forceFlush();
  const [s] = exporter.getFinishedSpans();
  assert.equal(s?.name, "documentLoad");
  assert.equal(s?.attributes["session.id"], undefined);
  assert.deepEqual(signals, []);
});

test("web's documentFetch belongs to the load view and is not a request", async () => {
  const { tp, exporter, signals } = setup();
  tp.getTracer("@libo11y/web")
    .startSpan("documentFetch", {
      kind: SpanKind.CLIENT,
      attributes: { "http.request.method": "GET", "url.full": "https://app.test/" },
    })
    .end();
  await tp.forceFlush();
  assert.equal(exporter.getFinishedSpans()[0]?.attributes["o11y.rum.view.id"], "v0");
  assert.deepEqual(signals, []);
});

test("a finished request leaves a breadcrumb of its method, host and status, never its path", async () => {
  const { tp, signals } = setup();
  const t = tp.getTracer("@libo11y/web");
  t.startSpan("GET", {
    kind: SpanKind.CLIENT,
    attributes: {
      "http.request.method": "GET",
      "url.full": "https://api.test/docs/42",
      "server.address": "api.test",
      "http.response.status_code": 200,
    },
  }).end();
  t.startSpan("POST", {
    kind: SpanKind.CLIENT,
    attributes: { "http.request.method": "POST", "url.full": "https://api.test/sign" },
  }).end();
  t.startSpan("rpc", {
    kind: SpanKind.CLIENT,
    attributes: {
      "http.request.method": "POST",
      "url.full": "https://api.test/docs.v1.Docs/Get",
      "rpc.method": "docs.v1.Docs/Get",
    },
  }).end();
  await tp.forceFlush();
  assert.deepEqual(
    signals.filter((s) => s.type === "breadcrumb"),
    [
      { type: "breadcrumb", kind: "fetch", label: "GET api.test 200", at: 5 },
      { type: "breadcrumb", kind: "fetch", label: "POST api.test failed", at: 5 },
      { type: "breadcrumb", kind: "rpc", label: "docs.v1.Docs/Get", at: 5 },
    ],
  );
});
