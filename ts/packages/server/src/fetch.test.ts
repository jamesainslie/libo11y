/**
 * instrumentFetch: the client span, context injection, http.client.request.duration with exemplars,
 * and the guarantee that neither globalThis.fetch nor the caller's Request or init is changed. Real
 * requests go to a local node:http server that echoes what it received; error and URL cases use an
 * injected fetch.
 */
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { createRecorder, type Recorder } from "@libo11y/test";
import { context, metrics, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { DataPoint, Histogram } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { instrumentFetch } from "./fetch.ts";
import { DURATION_BUCKETS } from "./http-common.ts";
import { close, listen } from "./test-support/http.ts";

const DURATION = "http.client.request.duration";

interface Echo {
  readonly method: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function echo(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const status = Number(new URL(req.url ?? "/", "http://x").searchParams.get("status") ?? "200");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }),
    );
  });
}

async function withRig(fn: (rec: Recorder, base: string) => Promise<void>): Promise<void> {
  const rec = await createRecorder({ serviceName: "fetch-test" });
  const { server, url } = await listen(echo);
  try {
    await fn(rec, url);
  } finally {
    await close(server);
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
      .filter((m) => m.descriptor.name === DURATION)
      .flatMap((m) => m.dataPoints as DataPoint<Histogram>[]),
  );
}

/** Runs fn inside a parent span and returns it, so injection has a trace to carry. */
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

test("the client span is named by method, injected into the request and parented by the caller's span", async () => {
  await withRig(async (rec, base) => {
    const traced = instrumentFetch(fetch, { telemetry: rec.telemetry });
    const { parent, result } = await inParent(
      rec,
      async () => (await traced(`${base}/items?x=1`)).json() as Promise<Echo>,
    );
    const span = onlyClient(rec);
    assert.equal(span.name, "GET");
    assert.equal(span.parentSpanContext?.spanId, parent.spanContext().spanId);
    const { traceId, spanId } = span.spanContext();
    assert.equal(result.headers.traceparent, `00-${traceId}-${spanId}-01`);
    const port = Number(new URL(base).port);
    assert.deepEqual(span.attributes, {
      "http.request.method": "GET",
      "server.address": "127.0.0.1",
      "server.port": port,
      "url.full": `${base}/items?x=1`,
      "http.response.status_code": 200,
    });
    assert.equal(span.status.code, SpanStatusCode.UNSET);
  });
});

test("propagate decides per URL whether context is injected", async () => {
  await withRig(async (rec, base) => {
    const seen: string[] = [];
    const traced = instrumentFetch(fetch, {
      telemetry: rec.telemetry,
      propagate: (url) => {
        seen.push(url.pathname);
        return url.pathname !== "/external";
      },
    });
    await inParent(rec, async () => {
      const internal = (await (await traced(`${base}/internal`)).json()) as Echo;
      const external = (await (await traced(`${base}/external`)).json()) as Echo;
      assert.ok(internal.headers.traceparent !== undefined);
      assert.equal(external.headers.traceparent, undefined);
    });
    assert.deepEqual(seen, ["/internal", "/external"]);
    assert.equal(clientSpans(rec).length, 2);
  });
});

test("a Request is sent with its method, headers and body, and is not changed", async () => {
  await withRig(async (rec, base) => {
    const traced = instrumentFetch(fetch, { telemetry: rec.telemetry, peerService: "inventory" });
    const req = new Request(`${base}/orders`, {
      method: "POST",
      headers: { "x-app": "1", "content-type": "text/plain" },
      body: "payload",
    });
    const got = (await (await traced(req)).json()) as Echo;
    assert.equal(got.method, "POST");
    assert.equal(got.body, "payload");
    assert.equal(got.headers["x-app"], "1");
    assert.ok(got.headers.traceparent !== undefined);
    assert.equal(req.headers.has("traceparent"), false);
    const span = onlyClient(rec);
    assert.equal(span.name, "POST");
    assert.equal(span.attributes["peer.service"], "inventory");
  });
});

test("a URL with an init is sent with the init's headers, and the init is not changed", async () => {
  await withRig(async (rec, base) => {
    const traced = instrumentFetch(fetch, { telemetry: rec.telemetry });
    const headers = new Headers({ "x-app": "2" });
    const init: RequestInit = { method: "PUT", headers, body: "b" };
    const plain: Record<string, string> = { "x-plain": "3" };
    const initWithObject: RequestInit = { headers: plain };
    const [one, two] = await inParent(rec, async () => [
      (await (await traced(new URL(`${base}/a`), init)).json()) as Echo,
      (await (await traced(`${base}/b`, initWithObject)).json()) as Echo,
    ]).then((r) => r.result);
    assert.equal(one?.method, "PUT");
    assert.equal(one?.headers["x-app"], "2");
    assert.ok(one?.headers.traceparent !== undefined);
    assert.equal(two?.headers["x-plain"], "3");
    assert.ok(two?.headers.traceparent !== undefined);
    assert.deepEqual([...headers.keys()], ["x-app"]);
    assert.equal(init.headers, headers);
    assert.deepEqual(Object.keys(init), ["method", "headers", "body"]);
    assert.deepEqual(plain, { "x-plain": "3" });
    assert.equal(initWithObject.headers, plain);
  });
});

test("init headers replace a Request's headers, as fetch does", async () => {
  await withRig(async (rec, base) => {
    const traced = instrumentFetch(fetch, { telemetry: rec.telemetry });
    const req = new Request(`${base}/r`, { headers: { "x-from-request": "1" } });
    const got = (await (await traced(req, { headers: { "x-from-init": "1" } })).json()) as Echo;
    assert.equal(got.headers["x-from-request"], undefined);
    assert.equal(got.headers["x-from-init"], "1");
    assert.ok(got.headers.traceparent !== undefined);
  });
});

test("4xx and 5xx responses set error.type to the status and the span status to error", async () => {
  await withRig(async (rec, base) => {
    const traced = instrumentFetch(fetch, { telemetry: rec.telemetry });
    await (await traced(`${base}/?status=404`)).text();
    await (await traced(`${base}/?status=502`)).text();
    await (await traced(`${base}/?status=302`)).text().catch(() => "");
    const [notFound, badGateway] = clientSpans(rec);
    assert.equal(notFound?.status.code, SpanStatusCode.ERROR);
    assert.equal(notFound?.attributes["error.type"], "404");
    assert.equal(badGateway?.attributes["error.type"], "502");
    assert.equal(badGateway?.attributes["http.response.status_code"], 502);
    const points = await durationPoints(rec);
    assert.deepEqual(points.map((p) => p.attributes["error.type"]).sort(), ["404", "502", undefined].sort());
  });
});

test("a network failure marks the span failed with the error's name, records the duration and re-throws", async () => {
  await withRig(async (rec) => {
    const traced = instrumentFetch(fetch, { telemetry: rec.telemetry });
    const { server, url } = await listen(() => {});
    await close(server);
    const err = await traced(`${url}/gone`).then(
      () => assert.fail("fetch to a closed port succeeded"),
      (e: unknown) => e as Error,
    );
    const span = onlyClient(rec);
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.attributes["error.type"], err.name);
    assert.equal(span.attributes["http.response.status_code"], undefined);
    assert.ok(span.events.some((e) => e.name === "exception"));
    const [point] = await durationPoints(rec);
    assert.equal(point?.attributes["error.type"], err.name);
  });
});

test("an abort is reported as AbortError", async () => {
  const rec = await createRecorder();
  try {
    const traced = instrumentFetch(fetch, { telemetry: rec.telemetry });
    await assert.rejects(traced("http://127.0.0.1:9/", { signal: AbortSignal.abort() }));
    assert.equal(onlyClient(rec).attributes["error.type"], "AbortError");
  } finally {
    await rec.shutdown();
  }
});

test("the duration histogram uses the semconv buckets and attributes and carries the span's exemplar", async () => {
  await withRig(async (rec, base) => {
    const traced = instrumentFetch(fetch, { telemetry: rec.telemetry });
    await inParent(rec, async () => (await traced(`${base}/x`)).text());
    const [point] = await durationPoints(rec);
    assert.deepEqual(point?.attributes, {
      "http.request.method": "GET",
      "server.address": "127.0.0.1",
      "server.port": Number(new URL(base).port),
      "http.response.status_code": 200,
    });
    assert.deepEqual(point?.value.buckets.boundaries, DURATION_BUCKETS);
    const span = onlyClient(rec);
    const exemplars = await rec.exemplars(DURATION);
    assert.equal(exemplars[0]?.traceId, span.spanContext().traceId);
    assert.equal(exemplars[0]?.spanId, span.spanContext().spanId);
    await rec.assertConforms();
  });
});

test("url.full drops userinfo, server.port defaults by scheme, and other methods are normalized", async () => {
  const rec = await createRecorder();
  try {
    // Node's Request rejects a URL with credentials, so the fake only counts calls.
    const sent: unknown[] = [];
    const fake = (async (input: string | URL | Request) => {
      sent.push(input);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const traced = instrumentFetch(fake, { telemetry: rec.telemetry });
    await traced("https://user:secret@api.example.com/v1?q=1");
    await traced("http://example.com/", { method: "get" });
    await traced("http://example.com/", { method: "PURGE" });
    const [secure, lower, purge] = clientSpans(rec);
    assert.equal(secure?.attributes["url.full"], "https://api.example.com/v1?q=1");
    assert.equal(secure?.attributes["server.port"], 443);
    assert.equal(secure?.attributes["server.address"], "api.example.com");
    assert.equal(lower?.name, "GET");
    assert.equal(lower?.attributes["http.request.method_original"], undefined);
    assert.equal(lower?.attributes["server.port"], 80);
    assert.equal(purge?.name, "HTTP");
    assert.equal(purge?.attributes["http.request.method"], "_OTHER");
    assert.equal(purge?.attributes["http.request.method_original"], "PURGE");
    assert.equal(sent.length, 3);
  } finally {
    await rec.shutdown();
  }
});

test("the span ends when the response headers arrive, before the body is read", async () => {
  const rec = await createRecorder();
  try {
    const fake = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((r) => setTimeout(r, 20));
            controller.close();
          },
        }),
      )) as unknown as typeof fetch;
    const res = await instrumentFetch(fake, { telemetry: rec.telemetry })("http://svc/");
    assert.equal(clientSpans(rec).length, 1);
    await res.text();
  } finally {
    await rec.shutdown();
  }
});

test("instrumentFetch never patches globalThis.fetch, and without a telemetry uses the globals", async () => {
  await withRig(async (rec, base) => {
    const before = globalThis.fetch;
    const traced = instrumentFetch();
    assert.equal(globalThis.fetch, before);
    trace.setGlobalTracerProvider(rec.telemetry.tracerProvider);
    metrics.setGlobalMeterProvider(rec.telemetry.meterProvider);
    propagation.setGlobalPropagator(rec.telemetry.propagator);
    let got: Echo;
    try {
      got = (await (await traced(`${base}/g`)).json()) as Echo;
    } finally {
      trace.disable();
      metrics.disable();
      propagation.disable();
    }
    const span = onlyClient(rec);
    assert.equal(got.headers.traceparent, `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
    assert.equal((await durationPoints(rec))[0]?.value.count, 1);
  });
});

test("a URL fetch cannot parse goes straight to fetch, uninstrumented", async () => {
  const rec = await createRecorder();
  try {
    let calls = 0;
    const fake = (async () => {
      calls++;
      throw new TypeError("Invalid URL");
    }) as unknown as typeof fetch;
    await assert.rejects(instrumentFetch(fake, { telemetry: rec.telemetry })("/relative"), TypeError);
    assert.equal(calls, 1);
    assert.equal(clientSpans(rec).length, 0);
  } finally {
    await rec.shutdown();
  }
});
