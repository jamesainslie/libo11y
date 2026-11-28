/**
 * instrumentFetch: the client span, context injection, http.client.request.duration with exemplars,
 * and the guarantee that neither globalThis.fetch nor the caller's Request or init is changed. Real
 * requests go to a local node:http server that echoes what it received; error and URL cases use an
 * injected fetch.
 */
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import type { Telemetry } from "@libo11y/core";
import { createRecorder, type Recorder } from "@libo11y/test";
import {
  context,
  metrics,
  propagation,
  SpanKind,
  SpanStatusCode,
  type TextMapPropagator,
  trace,
} from "@opentelemetry/api";
import type { DataPoint, Histogram } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { instrumentFetch } from "./fetch.ts";
import { DURATION_BUCKETS } from "./http-common.ts";
import { capturingDiag } from "./test-support/diag.ts";
import { capturingErrors } from "./test-support/errors.ts";
import { close, listen } from "./test-support/http.ts";
import { metricsRig } from "./test-support/metrics.ts";

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

test("url.full redacts the signature query values semconv names, leaving the rest as sent", async () => {
  const rec = await createRecorder();
  try {
    const fake = (async (_input: string | URL | Request) =>
      new Response(null, { status: 204 })) as typeof fetch;
    const traced = instrumentFetch(fake, { telemetry: rec.telemetry });
    await traced(
      "https://bucket.s3.amazonaws.com/k?X-Amz-Date=20261125&AWSAccessKeyId=AKIA123&Signature=abc%2Fdef&sig=s1&X-Goog-Signature=g1&q=a%20b&flag",
    );
    await traced("https://a.example.com/x?signature=keep&q=1#f");
    const [presigned, other] = clientSpans(rec);
    assert.equal(
      presigned?.attributes["url.full"],
      "https://bucket.s3.amazonaws.com/k?X-Amz-Date=20261125&AWSAccessKeyId=REDACTED&Signature=REDACTED&sig=REDACTED&X-Goog-Signature=REDACTED&q=a%20b&flag",
    );
    assert.equal(
      other?.attributes["url.full"],
      "https://a.example.com/x?signature=keep&q=1#f",
      "the keys match case-sensitively, as semconv lists them",
    );
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

test("a throwing propagate is treated as false, and the request is sent and its span ended", async () => {
  await withRig(async (rec, base) => {
    const traced = instrumentFetch(fetch, {
      telemetry: rec.telemetry,
      propagate: () => {
        throw new Error("policy broke");
      },
    });
    const got = (await inParent(rec, async () => (await traced(`${base}/x`)).json() as Promise<Echo>)).result;
    assert.equal(got.headers.traceparent, undefined);
    const span = onlyClient(rec);
    assert.equal(span.attributes["http.response.status_code"], 200);
    assert.equal(span.status.code, SpanStatusCode.UNSET);
  });
});

test("headers that cannot be copied fail the request through fetch's own error and end the span", async () => {
  const rec = await createRecorder();
  try {
    const traced = instrumentFetch((async () => new Response("unreached")) as unknown as typeof fetch, {
      telemetry: rec.telemetry,
    });
    await assert.rejects(traced("http://svc/", { headers: [["bad name", "v"]] }), TypeError);
    const span = onlyClient(rec);
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.attributes["error.type"], "TypeError");
  } finally {
    await rec.shutdown();
  }
});

// Site review: no telemetry step may fail the request. A propagator that throws, a span that cannot
// start and a span that cannot end are reported to the error handler, and the request goes on.
const THROWING_INJECT: TextMapPropagator = {
  inject() {
    throw new Error("inject boom");
  },
  extract: (ctx) => ctx,
  fields: () => [],
};

/** rec's telemetry with a tracer whose startSpan throws, or whose spans throw on end. */
function brokenTelemetry(rec: Recorder, broken: "start" | "end"): Telemetry {
  const tracer = rec.telemetry.tracerProvider.getTracer("broken");
  return {
    tracerProvider: {
      getTracer: () => ({
        startSpan: (...args: Parameters<typeof tracer.startSpan>) => {
          if (broken === "start") throw new Error("start boom");
          const span = tracer.startSpan(...args);
          return new Proxy(span, {
            get(target, key) {
              if (key === "end") {
                return () => {
                  throw new Error("end boom");
                };
              }
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      }),
    },
    meterProvider: rec.telemetry.meterProvider,
    propagator: rec.telemetry.propagator,
  } as unknown as Telemetry;
}

test("a propagator whose inject throws is reported, and the request is sent without the context", async () => {
  const rec = await createRecorder({ serviceName: "fetch-test", propagators: [THROWING_INJECT] });
  const { server, url } = await listen(echo);
  try {
    const traced = instrumentFetch(fetch, { telemetry: rec.telemetry });
    const init = { headers: { "x-app": "1" } };
    const { result, viaHandle, viaGlobal } = await capturingErrors(
      async () => (await traced(`${url}/x`, init)).json() as Promise<Echo>,
      rec.telemetry,
    );
    assert.equal(result.headers.traceparent, undefined);
    assert.equal(result.headers["x-app"], "1", "the caller's own headers still go out");
    assert.deepEqual(viaHandle, [
      "o11y: instrumentFetch: injecting the trace context failed, the request is sent without it: Error",
    ]);
    assert.deepEqual(viaGlobal, [], "a handle's reports go to the handle");
    const span = onlyClient(rec);
    assert.equal(span.attributes["http.response.status_code"], 200);
    assert.equal(span.status.code, SpanStatusCode.UNSET);
  } finally {
    await close(server);
    await rec.shutdown();
  }
});

test("a span that cannot start is reported, and the request is sent uninstrumented exactly once", async () => {
  await withRig(async (rec, base) => {
    let calls = 0;
    const counting = ((...args: Parameters<typeof fetch>) => {
      calls++;
      return fetch(...args);
    }) as typeof fetch;
    const traced = instrumentFetch(counting, { telemetry: brokenTelemetry(rec, "start") });
    const { result, errors } = await capturingErrors(async () => (await traced(`${base}/x`)).status);
    assert.equal(result, 200);
    assert.equal(calls, 1);
    assert.deepEqual(errors, [
      "o11y: instrumentFetch: starting the request's telemetry failed, the request is not instrumented: Error",
    ]);
  });
});

test("a span that cannot end is reported, and neither the response nor fetch's own error is replaced", async () => {
  await withRig(async (rec, base) => {
    const telemetry = brokenTelemetry(rec, "end");
    const ok = await capturingErrors(
      async () => (await instrumentFetch(fetch, { telemetry })(`${base}/x`)).status,
    );
    assert.equal(ok.result, 200);
    assert.deepEqual(ok.errors, ["o11y: instrumentFetch: ending the request's telemetry failed: Error"]);

    const down = new TypeError("fetch failed");
    const failing = (async () => {
      throw down;
    }) as unknown as typeof fetch;
    const failed = await capturingErrors(() =>
      assert.rejects(instrumentFetch(failing, { telemetry })("http://svc/"), (err) => err === down),
    );
    assert.equal(failed.errors.length, 1);
  });
});

test("whatever fetchImpl resolves with is returned as it is, even when it is not a Response", async () => {
  const rec = await createRecorder();
  try {
    const odd = (async () => undefined) as unknown as typeof fetch;
    const { result, errors } = await capturingErrors(() =>
      instrumentFetch(odd, { telemetry: rec.telemetry })("http://svc/"),
    );
    assert.equal(result, undefined);
    assert.deepEqual(errors, []);
    const span = onlyClient(rec);
    assert.equal(span.attributes["http.response.status_code"], undefined);
  } finally {
    await rec.shutdown();
  }
});

test("a propagate predicate that throws something that cannot be printed still sends the request", async () => {
  await withRig(async (rec, base) => {
    const traced = instrumentFetch(fetch, {
      telemetry: rec.telemetry,
      propagate: () => {
        throw Object.create(null);
      },
    });
    assert.equal((await traced(`${base}/x`)).status, 200);
  });
});

// Fourth review: the propagate option is a hook too. Its failure went to the diag logger with the
// thrown message, which a predicate handed the URL can fill with it.
test("a propagate option that throws is reported by class through the handle, never with its message", async () => {
  const thrown = new RangeError("unset");
  const rig = await metricsRig();
  try {
    const traced = instrumentFetch((async () => new Response("ok")) as unknown as typeof fetch, {
      telemetry: rig.telemetry,
      propagate: (url) => {
        thrown.message = `blocked ${url.href}`;
        throw thrown;
      },
    });
    let captured: Awaited<ReturnType<typeof capturingErrors<string>>> | undefined;
    const diagLines = await capturingDiag(async () => {
      captured = await capturingErrors(async () =>
        (await traced("http://upstream/pay?card=4111111111111111")).text(),
      );
    });
    assert.equal(captured?.result, "ok", "the request is sent");
    assert.deepEqual(captured?.viaGlobal, [], "a handle's reports go to the handle");
    assert.equal(rig.diagnostics.length, 1, rig.diagnostics.join("\n"));
    assert.match(
      rig.diagnostics[0] ?? "",
      /^time=\S+ level=WARN msg="o11y: telemetry error" error="o11y: instrumentFetch: the propagate option failed, the context is not sent: RangeError"$/,
    );
    const written = [...rig.diagnostics, ...diagLines].join("\n");
    for (const secret of ["4111111111111111", "blocked", "upstream/pay"]) {
      assert.ok(!written.includes(secret), `${secret} was written:\n${written}`);
    }
    assert.deepEqual(
      diagLines.filter((line) => /libo11y|o11y:/.test(line)),
      [],
      "nothing of this failure goes to the diag logger",
    );
    assert.match(thrown.message, /4111111111111111/, "the predicate did throw with the URL in its message");
  } finally {
    await rig.shutdown();
  }
});

test("a throwing propagate option keeps what was thrown on the report's cause, and without a handle reports globally", async () => {
  const thrown = new Error("policy broke");
  const propagate = (): boolean => {
    throw thrown;
  };
  const base = (async () => new Response("ok")) as unknown as typeof fetch;
  const rec = await createRecorder();
  try {
    const first = await capturingErrors(
      async () =>
        (await instrumentFetch(base, { telemetry: rec.telemetry, propagate })("http://svc/")).text(),
      rec.telemetry,
    );
    assert.deepEqual(first.viaHandle, [
      "o11y: instrumentFetch: the propagate option failed, the context is not sent: Error",
    ]);
    assert.deepEqual(first.viaGlobal, []);
    assert.equal((first.reports[0] as Error).cause, thrown);

    const second = await capturingErrors(async () =>
      (await instrumentFetch(base, { propagate })("http://svc/")).text(),
    );
    assert.equal(second.result, "ok");
    assert.deepEqual(second.viaGlobal, [
      "o11y: instrumentFetch: the propagate option failed, the context is not sent: Error",
    ]);
  } finally {
    await rec.shutdown();
  }
});
