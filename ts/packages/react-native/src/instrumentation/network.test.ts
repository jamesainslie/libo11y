import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecorder, type Recorder } from "@libo11y/test";
import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { FakeXhr, installFakeXhr, xhrFetch } from "../test-support/fake-xhr.ts";
import { installNetworkInstrumentation, type NetworkInstrumentation, RN_SCOPE } from "./network.ts";

const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

interface Harness {
  readonly rec: Recorder;
  readonly g: { fetch?: typeof fetch };
  install(opts?: Parameters<typeof installNetworkInstrumentation>[0]): NetworkInstrumentation;
}

/** Runs fn with FakeXhr as the global XMLHttpRequest, a global object whose fetch is xhrFetch, and a recorder. */
async function withNet(fn: (h: Harness) => Promise<void>): Promise<void> {
  const rec = await createRecorder({ serviceName: "rn-network-test" });
  const restoreXhr = installFakeXhr();
  const installed: NetworkInstrumentation[] = [];
  const g: { fetch?: typeof fetch } = { fetch: xhrFetch() };
  try {
    await fn({
      rec,
      g,
      install: (opts = {}) => {
        const n = installNetworkInstrumentation({ telemetry: rec.telemetry, ...opts }, g);
        installed.push(n);
        return n;
      },
    });
  } finally {
    for (const n of installed) n.uninstall();
    restoreXhr();
    await rec.shutdown();
  }
}

function clientSpans(rec: Recorder): ReadableSpan[] {
  return rec.spans().filter((s) => s.kind === SpanKind.CLIENT);
}

/** The XHR the last fetch call sent, answered with status. */
function answerLast(status = 200): FakeXhr {
  const xhr = FakeXhr.sent.at(-1);
  assert.ok(xhr, "a request was sent");
  xhr.respond(status);
  return xhr;
}

test("a global fetch over XHR, as bare React Native's whatwg-fetch, gives one span with context", async () => {
  await withNet(async ({ rec, g, install }) => {
    install({ propagateTo: ["https://api.test"] });
    const pending = g.fetch?.("https://api.test/items");
    const xhr = answerLast();
    await pending;
    const spans = clientSpans(rec);
    assert.equal(spans.length, 1);
    assert.equal(spans[0]?.instrumentationScope.name, "@libo11y/react-native");
    assert.equal(RN_SCOPE, "@libo11y/react-native");
    const { traceId, spanId } = spans[0]?.spanContext() ?? {};
    assert.equal(xhr.header("traceparent"), `00-${traceId}-${spanId}-01`, "the fetch span's context, once");
    assert.equal(xhr.headers.filter(([k]) => k.toLowerCase() === "traceparent").length, 1);
  });
});

test("a plain XHR outside fetch gets its own span", async () => {
  await withNet(async ({ rec, install }) => {
    install();
    const xhr = new FakeXhr();
    xhr.open("POST", "https://api.test/xhr");
    xhr.send("x");
    xhr.respond(201);
    const [span] = clientSpans(rec);
    assert.equal(clientSpans(rec).length, 1);
    assert.equal(span?.name, "POST");
    assert.equal(span?.instrumentationScope.name, RN_SCOPE);
    assert.equal(span?.attributes["http.response.status_code"], 201);
  });
});

test("an app has no origin: traceparent goes only to propagateTo", async () => {
  await withNet(async ({ g, install }) => {
    install();
    const pending = g.fetch?.("https://api.test/items");
    const xhr = answerLast();
    await pending;
    assert.equal(xhr.header("traceparent"), undefined);
  });
});

test("traceFetch wraps a native fetch the patch cannot see, once, and leaves wrapped ones alone", async () => {
  await withNet(async ({ rec, g, install }) => {
    const net = install({ propagateTo: ["https://api.test"] });
    const seen: Headers[] = [];
    const expoFetch = (async (_i: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response("ok");
    }) as typeof fetch;
    const traced = net.traceFetch(expoFetch);
    await traced("https://api.test/rpc", { method: "POST" });
    assert.match(seen[0]?.get("traceparent") ?? "", TRACEPARENT);
    assert.equal(net.traceFetch(expoFetch), traced, "one wrapper per fetch");
    assert.equal(net.traceFetch(traced), traced, "a wrapped fetch is not wrapped again");
    assert.equal(net.traceFetch(g.fetch as typeof fetch), g.fetch, "the patched global is returned as is");
    const spans = clientSpans(rec);
    assert.equal(spans.length, 1);
    assert.equal(spans[0]?.name, "POST");
  });
});

test("a traced wrapper over the patched global fetch records one span, the outer one", async () => {
  await withNet(async ({ rec, g, install }) => {
    const net = install();
    const wrapper = ((input: string | URL | Request, init?: RequestInit) =>
      (g.fetch as typeof fetch)(input, init)) as typeof fetch;
    const pending = net.traceFetch(wrapper)("https://api.test/w", { method: "PUT" });
    answerLast();
    await pending;
    const spans = clientSpans(rec);
    assert.equal(spans.length, 1);
    assert.equal(spans[0]?.name, "PUT");
  });
});

test("traceFetch works with the global patches off", async () => {
  await withNet(async ({ rec, g, install }) => {
    const before = g.fetch;
    const { open } = FakeXhr.prototype;
    const net = install({ fetch: false, xhr: false });
    assert.equal(g.fetch, before);
    assert.equal(FakeXhr.prototype.open, open);
    await net.traceFetch((async () => new Response("ok")) as typeof fetch)("https://api.test/a");
    assert.equal(clientSpans(rec).length, 1);
  });
});

test("ignored URLs get no span from fetch or XHR", async () => {
  await withNet(async ({ rec, g, install }) => {
    install({ ignoreUrls: ["https://gw.test/_o11y/v1/traces"] });
    const pending = g.fetch?.("https://gw.test/_o11y/v1/traces", { method: "POST" });
    answerLast();
    await pending;
    assert.equal(clientSpans(rec).length, 0);
  });
});

test("uninstall restores the globals it patched, and a traced fetch then passes straight through", async () => {
  await withNet(async ({ rec, g, install }) => {
    const before = { fetch: g.fetch, open: FakeXhr.prototype.open, send: FakeXhr.prototype.send };
    const net = install();
    const traced = net.traceFetch((async () => new Response("ok")) as typeof fetch);
    assert.notEqual(g.fetch, before.fetch);
    net.uninstall();
    net.uninstall();
    assert.equal(g.fetch, before.fetch);
    assert.equal(FakeXhr.prototype.open, before.open);
    assert.equal(FakeXhr.prototype.send, before.send);
    await traced("https://api.test/a");
    assert.equal(clientSpans(rec).length, 0);
  });
});

test("a global fetch replaced after install is left in place by uninstall", async () => {
  await withNet(async ({ g, install }) => {
    const net = install();
    const later = (async () => new Response("later")) as typeof fetch;
    g.fetch = later;
    net.uninstall();
    assert.equal(g.fetch, later);
  });
});
