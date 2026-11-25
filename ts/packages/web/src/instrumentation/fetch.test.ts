/**
 * instrumentFetch and installFetchInstrumentation: the client span as on the server, injection
 * only to allowed origins, nothing at all while consent is closed or for an ignored URL, onStart,
 * the caller's Request and init left alone, and install restoring globalThis.fetch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Telemetry } from "@libo11y/core";
import { createRecorder, type Recorder } from "@libo11y/test";
import { context, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { DataPoint, Histogram } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { setActiveConsent } from "../consent/active.ts";
import type { Consent, ConsentState } from "../contracts/consent.ts";
import type { HttpRequestInfo } from "../options.ts";
import { installFetchInstrumentation, instrumentFetch } from "./fetch.ts";
import { DURATION_BUCKETS, DURATION_METRIC } from "./http-common.ts";

const PAGE = "https://app.example.com/page";

interface Call {
  readonly input: string | URL | Request;
  readonly init: RequestInit | undefined;
  /** The headers fetch would send: init's over the Request's. */
  readonly headers: Headers;
}

/** A fake fetch that records each call and answers with status (default 200). */
function fakeFetch(status = 200): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const fromRequest = input instanceof Request ? input.headers : undefined;
    calls.push({ input, init, headers: new Headers(init?.headers ?? fromRequest) });
    return new Response(null, { status });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

/** A consent whose state the test sets. */
function settableConsent(initial: ConsentState): Consent & { set(s: ConsentState): void } {
  let state = initial;
  return {
    state: () => state,
    grant: () => {
      state = "granted";
      return state;
    },
    revoke: async () => {
      state = "denied";
    },
    subscribe: () => () => {},
    set: (s) => {
      state = s;
    },
  };
}

/** The recorder's telemetry extended with a consent, as a WebTelemetry. */
function withConsent(telemetry: Telemetry, consent: Consent): Telemetry {
  return Object.assign(Object.create(telemetry) as object, { consent }) as unknown as Telemetry;
}

/** Runs fn with globalThis.location at href, restoring what was there. */
async function atPage<T>(href: string, fn: () => Promise<T>): Promise<T> {
  const before = Object.getOwnPropertyDescriptor(globalThis, "location");
  const url = new URL(href);
  Object.defineProperty(globalThis, "location", {
    value: { href: url.href, origin: url.origin },
    configurable: true,
    writable: true,
  });
  try {
    return await fn();
  } finally {
    if (before !== undefined) Object.defineProperty(globalThis, "location", before);
    else delete (globalThis as { location?: unknown }).location;
  }
}

async function withRec(fn: (rec: Recorder) => Promise<void>): Promise<void> {
  const rec = await createRecorder({ serviceName: "web-fetch-test" });
  try {
    await atPage(PAGE, () => fn(rec));
  } finally {
    await rec.shutdown();
  }
}

function clientSpans(rec: Recorder): ReadableSpan[] {
  return rec.spans().filter((s) => s.kind === SpanKind.CLIENT);
}

function onlyClient(rec: Recorder): ReadableSpan {
  const spans = clientSpans(rec);
  assert.equal(spans.length, 1, `want one client span, got ${spans.map((s) => s.name).join(", ")}`);
  return spans[0] as ReadableSpan;
}

async function durationPoints(rec: Recorder): Promise<DataPoint<Histogram>[]> {
  const rm = await rec.metrics();
  return rm.scopeMetrics.flatMap((sm) =>
    sm.metrics
      .filter((m) => m.descriptor.name === DURATION_METRIC)
      .flatMap((m) => m.dataPoints as DataPoint<Histogram>[]),
  );
}

async function inParent<T>(
  rec: Recorder,
  fn: () => Promise<T>,
): Promise<{ parent: ReadableSpan; result: T }> {
  const span = rec.telemetry.tracerProvider.getTracer("app").startSpan("parent");
  const result = await context.with(trace.setSpan(context.active(), span), fn);
  span.end();
  const parent = rec.spans().find((s) => s.name === "parent") as ReadableSpan;
  return { parent, result };
}

test("a same-origin request gets a CLIENT span named by method, parented by the caller, with context injected", async () => {
  await withRec(async (rec) => {
    const fake = fakeFetch();
    const traced = instrumentFetch(fake.fetch, { telemetry: rec.telemetry });
    const { parent } = await inParent(rec, () => traced("/api/items?x=1"));
    const span = onlyClient(rec);
    assert.equal(span.name, "GET");
    assert.equal(span.parentSpanContext?.spanId, parent.spanContext().spanId);
    assert.equal(span.instrumentationScope.name, "@libo11y/web");
    const { traceId, spanId } = span.spanContext();
    assert.equal(fake.calls[0]?.headers.get("traceparent"), `00-${traceId}-${spanId}-01`);
    assert.deepEqual(span.attributes, {
      "http.request.method": "GET",
      "server.address": "app.example.com",
      "server.port": 443,
      "url.full": "https://app.example.com/api/items?x=1",
      "http.response.status_code": 200,
    });
    assert.equal(span.status.code, SpanStatusCode.UNSET);
    assert.equal(fake.calls[0]?.input, "/api/items?x=1", "the input is passed on as given");
  });
});

test("a traceparent the caller set is replaced by the client span's, as on the server", async () => {
  await withRec(async (rec) => {
    const fake = fakeFetch();
    const traced = instrumentFetch(fake.fetch, { telemetry: rec.telemetry });
    const callerParent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    await traced("/api/items", { headers: { TraceParent: callerParent } });
    const { traceId, spanId } = onlyClient(rec).spanContext();
    // Headers.set replaces, so exactly one traceparent leaves, naming the client span.
    assert.equal(fake.calls[0]?.headers.get("traceparent"), `00-${traceId}-${spanId}-01`);
  });
});

test("a cross-origin request gets a span but no context, unless propagateTo allows its origin", async () => {
  await withRec(async (rec) => {
    const fake = fakeFetch();
    const plain = instrumentFetch(fake.fetch, { telemetry: rec.telemetry });
    const allowed = instrumentFetch(fake.fetch, {
      telemetry: rec.telemetry,
      propagateTo: ["https://api.example.com", /^https:\/\/cdn\./],
    });
    await inParent(rec, async () => {
      await plain("https://api.example.com/x");
      await allowed("https://api.example.com/x");
      await allowed("https://cdn.example.net/y");
      await allowed("https://other.example.org/z");
    });
    assert.deepEqual(
      fake.calls.map((c) => c.headers.has("traceparent")),
      [false, true, true, false],
    );
    assert.equal(clientSpans(rec).length, 4);
  });
});

test("while consent is pending or denied there is no span, no metric and no injected header", async () => {
  await withRec(async (rec) => {
    const consent = settableConsent("pending");
    const fake = fakeFetch();
    const traced = instrumentFetch(fake.fetch, { telemetry: withConsent(rec.telemetry, consent) });
    await inParent(rec, async () => {
      await traced("/a");
      consent.set("denied");
      await traced("/b");
    });
    assert.equal(clientSpans(rec).length, 0);
    assert.equal(fake.calls.length, 2);
    assert.ok(fake.calls.every((c) => !c.headers.has("traceparent") && c.init === undefined));
    assert.equal((await durationPoints(rec)).length, 0);
    consent.set("granted");
    await inParent(rec, () => traced("/c"));
    assert.equal(clientSpans(rec).length, 1);
    assert.ok(fake.calls[2]?.headers.has("traceparent"));
  });
});

test("without a telemetry the active consent is honoured", async () => {
  await withRec(async (rec) => {
    const consent = settableConsent("pending");
    setActiveConsent(consent);
    trace.setGlobalTracerProvider(rec.telemetry.tracerProvider);
    try {
      const fake = fakeFetch();
      const traced = instrumentFetch(fake.fetch);
      await traced("/a");
      assert.equal(clientSpans(rec).length, 0);
      consent.set("granted");
      await traced("/b");
      assert.equal(clientSpans(rec).length, 1);
    } finally {
      setActiveConsent(undefined);
      trace.disable();
    }
  });
});

test("an ignored URL gets no span and no context", async () => {
  await withRec(async (rec) => {
    const fake = fakeFetch();
    const traced = instrumentFetch(fake.fetch, {
      telemetry: rec.telemetry,
      ignoreUrls: ["https://app.example.com/otlp/", /\/health$/],
    });
    await inParent(rec, async () => {
      await traced("/otlp/v1/traces", { method: "POST", body: "{}" });
      await traced("https://app.example.com/health");
      await traced("/kept");
    });
    assert.equal(onlyClient(rec).attributes["url.full"], "https://app.example.com/kept");
    assert.equal(fake.calls[0]?.headers.has("traceparent"), false);
    assert.equal(fake.calls[1]?.headers.has("traceparent"), false);
  });
});

test("onStart sees the started span and the request before it is sent, and may rename it", async () => {
  await withRec(async (rec) => {
    const fake = fakeFetch();
    const seen: { request: HttpRequestInfo; calls: number }[] = [];
    const traced = instrumentFetch(fake.fetch, {
      telemetry: rec.telemetry,
      onStart: (span: Span, request) => {
        seen.push({ request, calls: fake.calls.length });
        span.updateName("GET /items/:id");
        span.setAttribute("app.route", "/items/:id");
      },
    });
    await traced("/items/7", { method: "put" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.calls, 0, "onStart runs before the request is sent");
    assert.equal(seen[0]?.request.kind, "fetch");
    assert.equal(seen[0]?.request.method, "PUT");
    assert.equal(seen[0]?.request.url.href, "https://app.example.com/items/7");
    const span = onlyClient(rec);
    assert.equal(span.name, "GET /items/:id");
    assert.equal(span.attributes["app.route"], "/items/:id");
  });
});

test("a throwing onStart is isolated: the request is sent and its span ended", async () => {
  await withRec(async (rec) => {
    const fake = fakeFetch();
    const traced = instrumentFetch(fake.fetch, {
      telemetry: rec.telemetry,
      onStart: () => {
        throw new Error("hook broke");
      },
    });
    const res = await traced("/x");
    assert.equal(res.status, 200);
    assert.equal(fake.calls.length, 1);
    assert.ok(fake.calls[0]?.headers.has("traceparent"));
    assert.equal(onlyClient(rec).status.code, SpanStatusCode.UNSET);
  });
});

test("the caller's Request and init are never changed", async () => {
  await withRec(async (rec) => {
    const fake = fakeFetch();
    const traced = instrumentFetch(fake.fetch, { telemetry: rec.telemetry });
    const req = new Request("https://app.example.com/orders", {
      method: "POST",
      headers: { "x-app": "1" },
      body: "payload",
    });
    await traced(req);
    assert.equal(req.headers.has("traceparent"), false);
    assert.equal(fake.calls[0]?.headers.get("x-app"), "1");
    assert.ok(fake.calls[0]?.headers.has("traceparent"));

    const headers = new Headers({ "x-app": "2" });
    const plain: Record<string, string> = { "x-plain": "3" };
    const init: RequestInit = { method: "PUT", headers, body: "b" };
    const initWithObject: RequestInit = { headers: plain };
    await traced("/a", init);
    await traced("/b", initWithObject);
    assert.deepEqual([...headers.keys()], ["x-app"]);
    assert.equal(init.headers, headers);
    assert.deepEqual(Object.keys(init), ["method", "headers", "body"]);
    assert.deepEqual(plain, { "x-plain": "3" });
    assert.equal(fake.calls[1]?.headers.get("x-app"), "2");
    assert.equal(fake.calls[2]?.headers.get("x-plain"), "3");
    assert.equal(
      clientSpans(rec)
        .map((s) => s.name)
        .join(","),
      "POST,PUT,GET",
    );
  });
});

test("4xx, 5xx and failures mark the span failed, and the duration histogram carries the exemplar", async () => {
  await withRec(async (rec) => {
    const notFound = instrumentFetch(fakeFetch(404).fetch, { telemetry: rec.telemetry });
    await notFound("/missing");
    const failing = instrumentFetch(
      (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
      { telemetry: rec.telemetry },
    );
    await assert.rejects(failing("/down"), TypeError);
    const [missing, down] = clientSpans(rec);
    assert.equal(missing?.status.code, SpanStatusCode.ERROR);
    assert.equal(missing?.attributes["error.type"], "404");
    assert.equal(missing?.attributes["http.response.status_code"], 404);
    assert.equal(down?.status.code, SpanStatusCode.ERROR);
    assert.equal(down?.attributes["error.type"], "TypeError");
    assert.ok(down?.events.some((e) => e.name === "exception"));
    const points = await durationPoints(rec);
    assert.deepEqual(points.map((p) => p.attributes["error.type"]).sort(), ["404", "TypeError"]);
    assert.deepEqual(points[0]?.value.buckets.boundaries, DURATION_BUCKETS);
    assert.deepEqual(
      Object.keys(points.find((p) => p.attributes["error.type"] === "404")?.attributes ?? {}).sort(),
      ["error.type", "http.request.method", "http.response.status_code", "server.address", "server.port"],
    );
    const exemplars = await rec.exemplars(DURATION_METRIC);
    const ids = new Set(clientSpans(rec).map((s) => s.spanContext().spanId));
    assert.ok(exemplars.length > 0 && exemplars.every((e) => e.spanId !== undefined && ids.has(e.spanId)));
  });
});

test("a URL that cannot be resolved goes straight to fetch, uninstrumented", async () => {
  const rec = await createRecorder();
  try {
    const fake = fakeFetch();
    await instrumentFetch(fake.fetch, { telemetry: rec.telemetry })("/relative-without-page");
    assert.equal(fake.calls.length, 1);
    assert.equal(clientSpans(rec).length, 0);
  } finally {
    await rec.shutdown();
  }
});

test("install replaces globalThis.fetch, a second install is a no-op, and uninstall restores it", async () => {
  await withRec(async (rec) => {
    const original = globalThis.fetch;
    const fake = fakeFetch();
    globalThis.fetch = fake.fetch;
    try {
      const uninstall = installFetchInstrumentation({ telemetry: rec.telemetry });
      const patched = globalThis.fetch;
      assert.notEqual(patched, fake.fetch);
      const again = installFetchInstrumentation({ telemetry: rec.telemetry });
      assert.equal(globalThis.fetch, patched, "a second install does not wrap again");
      again();
      assert.equal(globalThis.fetch, patched, "the second install's uninstall is a no-op");
      await globalThis.fetch("/x");
      assert.equal(clientSpans(rec).length, 1);
      uninstall();
      assert.equal(globalThis.fetch, fake.fetch);
      uninstall();
      assert.equal(globalThis.fetch, fake.fetch);

      const reinstall = installFetchInstrumentation({ telemetry: rec.telemetry });
      const someoneElse = fakeFetch().fetch;
      globalThis.fetch = someoneElse;
      reinstall();
      assert.equal(globalThis.fetch, someoneElse, "a fetch replaced after install is left alone");
    } finally {
      globalThis.fetch = original;
    }
  });
});

test("after uninstall a patch still reached through a later wrapper passes straight through", async () => {
  await withRec(async (rec) => {
    const original = globalThis.fetch;
    const fake = fakeFetch();
    globalThis.fetch = fake.fetch;
    try {
      const uninstall = installFetchInstrumentation({ telemetry: rec.telemetry });
      const ours = globalThis.fetch;
      // Another library wraps fetch after us, so uninstall cannot put the original back.
      const wrapper = ((input: string | URL | Request, init?: RequestInit) =>
        ours(input, init)) as typeof fetch;
      globalThis.fetch = wrapper;
      uninstall();
      assert.equal(globalThis.fetch, wrapper);
      await globalThis.fetch("/after-uninstall");
      assert.equal(clientSpans(rec).length, 0, "an uninstalled patch records nothing");
      assert.equal(fake.calls[0]?.headers.has("traceparent"), false, "and injects nothing");

      const reinstall = installFetchInstrumentation({ telemetry: rec.telemetry });
      await globalThis.fetch("/reinstalled");
      assert.equal(clientSpans(rec).length, 1, "a reinstall over the wrapper records one span, not two");
      reinstall();
    } finally {
      globalThis.fetch = original;
    }
  });
});

test("data:, blob: and other non-HTTP URLs get no span and no context", async () => {
  await withRec(async (rec) => {
    const fake = fakeFetch();
    const traced = instrumentFetch(fake.fetch, { telemetry: rec.telemetry, propagateTo: [/.*/] });
    await traced(`data:text/plain;base64,${btoa("secret payload")}`);
    await traced("blob:https://app.example.com/0b5c2a52-9f0e-4a43-9a43-7f6b1f7c5d10");
    await traced("about:blank");
    assert.equal(fake.calls.length, 3);
    assert.equal(clientSpans(rec).length, 0);
    assert.ok(fake.calls.every((c) => !c.headers.has("traceparent")));
    assert.equal((await durationPoints(rec)).length, 0);
  });
});

test("a Request from another realm is read as a Request, not stringified", async () => {
  await withRec(async (rec) => {
    const fake = fakeFetch();
    const traced = instrumentFetch(fake.fetch, { telemetry: rec.telemetry });
    // A Request from an iframe fails instanceof Request here; its brand is its toStringTag.
    const foreign = {
      url: "https://app.example.com/orders",
      method: "POST",
      headers: new Headers({ authorization: "Bearer t" }),
      [Symbol.toStringTag]: "Request",
    } as unknown as Request;
    await traced(foreign);
    const span = onlyClient(rec);
    assert.equal(span.name, "POST");
    assert.equal(span.attributes["url.full"], "https://app.example.com/orders");
    assert.equal(fake.calls[0]?.input, foreign);
    const sent = fake.calls[0]?.init?.headers as Headers;
    assert.equal(sent.get("authorization"), "Bearer t", "the Request's own headers are kept");
    assert.ok(sent.has("traceparent"));
  });
});
