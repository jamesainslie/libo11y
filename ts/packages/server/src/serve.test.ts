/**
 * instrumentServe: the server span, the duration histogram and the canonical line, following Go's
 * o11yhttp. Handlers are called directly with a Request, then under node:http on both runtimes and
 * under Bun.serve on Bun. The recorder installs the global context manager while it runs.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { currentRecord } from "@libo11y/core";
import { createRecorder, type Recorder } from "@libo11y/test";
import {
  type Context,
  context,
  metrics,
  propagation,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import type { DataPoint, Histogram } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { DURATION_BUCKETS, normalizeMethod } from "./http-common.ts";
import { instrumentServe, type ServeOptions, setRoute } from "./serve.ts";
import { bun, close, IS_BUN, listen, nodeListener } from "./test-support/http.ts";

const DURATION = "http.server.request.duration";
const INBOUND_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const INBOUND_SPAN = "00f067aa0ba902b7";
const TRACEPARENT = `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01`;

async function withRecorder(fn: (rec: Recorder) => Promise<void>): Promise<void> {
  const rec = await createRecorder({ serviceName: "serve-test" });
  try {
    await fn(rec);
  } finally {
    await rec.shutdown();
  }
}

function serverSpans(rec: Recorder): ReadableSpan[] {
  return rec.spans().filter((s) => s.kind === SpanKind.SERVER);
}

function onlySpan(rec: Recorder): ReadableSpan {
  const spans = serverSpans(rec);
  assert.equal(spans.length, 1, `want one server span, got ${spans.map((s) => s.name).join(", ")}`);
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

function summaries(rec: Recorder) {
  return rec.logs().filter((l) => l.eventName === "o11y.request.summary");
}

const ok = async (): Promise<Response> => new Response("ok");

test("normalizeMethod keeps known methods, upper-cases known ones in another case and maps the rest to _OTHER", () => {
  assert.deepEqual(normalizeMethod("GET"), { method: "GET" });
  assert.deepEqual(normalizeMethod("patch"), { method: "PATCH", original: "patch" });
  assert.deepEqual(normalizeMethod("PURGE"), { method: "_OTHER", original: "PURGE" });
  assert.deepEqual(normalizeMethod(""), { method: "_OTHER" });
});

test("spans are named by method and route, a method outside the set names the span HTTP", async () => {
  await withRecorder(async (rec) => {
    const handler = instrumentServe(ok, {
      telemetry: rec.telemetry,
      route: (req) => (new URL(req.url).pathname.startsWith("/projects/") ? "/projects/:id" : undefined),
    });
    await (
      await handler(
        new Request("http://example.com:8080/projects/7", { headers: { "user-agent": "probe/1" } }),
      )
    ).text();
    await (await handler(new Request("https://example.com/other", { method: "PURGE" }))).text();
    await (await handler(new Request("http://example.com/plain", { method: "POST", body: "x" }))).text();
    const [routed, other, plain] = serverSpans(rec);
    assert.equal(routed?.name, "GET /projects/:id");
    assert.deepEqual(routed?.attributes, {
      "http.request.method": "GET",
      "url.scheme": "http",
      "url.path": "/projects/7",
      "server.address": "example.com",
      "server.port": 8080,
      "user_agent.original": "probe/1",
      "http.route": "/projects/:id",
      "http.response.status_code": 200,
    });
    assert.equal(other?.name, "HTTP");
    assert.equal(other?.attributes["http.request.method"], "_OTHER");
    assert.equal(other?.attributes["http.request.method_original"], "PURGE");
    assert.equal(other?.attributes["url.scheme"], "https");
    assert.equal(other?.attributes["server.port"], 443);
    assert.equal(other?.attributes["http.route"], undefined);
    assert.equal(plain?.name, "POST");
    assert.equal(plain?.attributes["server.port"], 80);
    for (const span of [routed, other, plain]) assert.equal(span?.kind, SpanKind.SERVER);
  });
});

test("a route that starts with a method names the span verbatim, and http.route drops the method", async () => {
  await withRecorder(async (rec) => {
    const handler = instrumentServe(ok, { telemetry: rec.telemetry, route: () => "GET /users/:id" });
    await (await handler(new Request("http://svc/users/1"))).text();
    const span = onlySpan(rec);
    assert.equal(span.name, "GET /users/:id");
    assert.equal(span.attributes["http.route"], "/users/:id");
  });
});

test("the span adopts the inbound trace context by default", async () => {
  await withRecorder(async (rec) => {
    const handler = instrumentServe(ok, { telemetry: rec.telemetry });
    await (await handler(new Request("http://svc/", { headers: { traceparent: TRACEPARENT } }))).text();
    const span = onlySpan(rec);
    assert.equal(span.spanContext().traceId, INBOUND_TRACE);
    assert.equal(span.parentSpanContext?.spanId, INBOUND_SPAN);
    assert.deepEqual(span.links, []);
  });
});

test("a public endpoint starts a new root linked to the inbound context and still extracts baggage", async () => {
  await withRecorder(async (rec) => {
    let baggage: string | undefined;
    const handler = instrumentServe(
      async () => {
        baggage ??= propagation.getBaggage(context.active())?.getEntry("tenant")?.value;
        return new Response("ok");
      },
      { telemetry: rec.telemetry, publicEndpoint: true },
    );
    await (
      await handler(
        new Request("http://svc/", { headers: { traceparent: TRACEPARENT, baggage: "tenant=acme" } }),
      )
    ).text();
    await (await handler(new Request("http://svc/"))).text();
    const [linked, bare] = serverSpans(rec);
    assert.notEqual(linked?.spanContext().traceId, INBOUND_TRACE);
    assert.equal(linked?.parentSpanContext, undefined);
    assert.equal(linked?.links.length, 1);
    assert.equal(linked?.links[0]?.context.traceId, INBOUND_TRACE);
    assert.equal(linked?.links[0]?.context.spanId, INBOUND_SPAN);
    assert.equal(baggage, "acme");
    assert.deepEqual(bare?.links, []);
  });
});

test("the handler runs inside the server span, so its spans and logs are children", async () => {
  await withRecorder(async (rec) => {
    const handler = instrumentServe(
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        rec.telemetry.tracerProvider.getTracer("app").startSpan("child").end();
        rec.telemetry.logger.info("handled");
        return new Response("ok");
      },
      { telemetry: rec.telemetry },
    );
    await (await handler(new Request("http://svc/"))).text();
    const server = onlySpan(rec);
    const child = rec.spans().find((s) => s.name === "child");
    assert.equal(child?.parentSpanContext?.spanId, server.spanContext().spanId);
    const log = rec.logs().find((l) => l.body === "handled");
    assert.equal(log?.spanId, server.spanContext().spanId);
  });
});

test("the duration histogram uses the semconv buckets, the request attributes and carries an exemplar", async () => {
  await withRecorder(async (rec) => {
    const handler = instrumentServe(async () => new Response("no", { status: 404 }), {
      telemetry: rec.telemetry,
      route: () => "/items/:id",
    });
    await (await handler(new Request("http://svc/items/1"))).text();
    const [point] = await durationPoints(rec);
    assert.deepEqual(point?.attributes, {
      "http.request.method": "GET",
      "url.scheme": "http",
      "http.route": "/items/:id",
      "http.response.status_code": 404,
    });
    assert.deepEqual(point?.value.buckets.boundaries, DURATION_BUCKETS);
    assert.equal(point?.value.count, 1);
    const span = onlySpan(rec);
    assert.equal(span.status.code, SpanStatusCode.UNSET);
    const exemplars = await rec.exemplars(DURATION);
    assert.equal(exemplars[0]?.traceId, span.spanContext().traceId);
    assert.equal(exemplars[0]?.spanId, span.spanContext().spanId);
  });
});

test("a 5xx response sets error.type to the status and the span status to error", async () => {
  await withRecorder(async (rec) => {
    const handler = instrumentServe(async () => new Response(null, { status: 503 }), {
      telemetry: rec.telemetry,
    });
    await handler(new Request("http://svc/"));
    const span = onlySpan(rec);
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.attributes["error.type"], "503");
    assert.equal(span.attributes["http.response.status_code"], 503);
    const [point] = await durationPoints(rec);
    assert.equal(point?.attributes["error.type"], "503");
  });
});

test("a throw records the exception and a 500, sets error.type to the error's class, and re-throws", async () => {
  await withRecorder(async (rec) => {
    class LedgerError extends Error {}
    const boom = new LedgerError("ledger unavailable");
    const handler = instrumentServe(
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        throw boom;
      },
      { telemetry: rec.telemetry, canonicalLine: true },
    );
    await assert.rejects(handler(new Request("http://svc/")), (err) => err === boom);
    const span = onlySpan(rec);
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.attributes["http.response.status_code"], 500);
    assert.equal(span.attributes["error.type"], "LedgerError");
    assert.equal(
      span.events.find((e) => e.name === "exception")?.attributes?.["exception.message"],
      boom.message,
    );
    const [point] = await durationPoints(rec);
    assert.equal(point?.attributes["http.response.status_code"], 500);
    assert.equal(point?.attributes["error.type"], "LedgerError");
    const [summary] = summaries(rec);
    assert.equal(summary?.attributes["http.response.status_code"], 500);
    assert.equal(summary?.attributes["o11y.outcome"], "failure");
  });
});

test("a watched event stream ends the span and the duration when it finishes, not when the handler returns", async () => {
  await withRecorder(async (rec) => {
    const encoder = new TextEncoder();
    const handler = instrumentServe(
      async () => {
        let n = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise((r) => setTimeout(r, 30));
              if (n++ < 2) controller.enqueue(encoder.encode("x"));
              else controller.close();
            },
          }),
          { headers: { "content-type": "Text/Event-Stream; charset=utf-8" } },
        );
      },
      { telemetry: rec.telemetry },
    );
    const res = await handler(new Request("http://svc/stream"));
    assert.equal(serverSpans(rec).length, 0, "the span ended before the body was read");
    assert.equal(await res.text(), "xx");
    const span = onlySpan(rec);
    const [point] = await durationPoints(rec);
    assert.ok((point?.value.sum ?? 0) >= 0.08, `duration ${point?.value.sum} is shorter than the body`);
    assert.ok(span.duration[0] * 1e3 + span.duration[1] / 1e6 >= 80);
  });
});

test("a cancelled body ends the span, an erroring body marks it failed, a null body ends it at once", async () => {
  await withRecorder(async (rec) => {
    const failing = new Error("disk gone");
    const handler = instrumentServe(
      async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/empty") return new Response(null, { status: 204 });
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (path === "/error") controller.error(failing);
              else controller.enqueue(new Uint8Array([1]));
            },
          }),
        );
      },
      { telemetry: rec.telemetry, canonicalLine: true, watchBody: () => true },
    );
    await handler(new Request("http://svc/empty"));
    assert.equal(serverSpans(rec).length, 1);

    const cancelled = await handler(new Request("http://svc/cancel"));
    await cancelled.body?.cancel();
    assert.equal(serverSpans(rec).length, 2);
    assert.equal(serverSpans(rec)[1]?.status.code, SpanStatusCode.UNSET);

    const erroring = await handler(new Request("http://svc/error"));
    await assert.rejects(erroring.text());
    const failed = serverSpans(rec)[2];
    assert.equal(failed?.status.code, SpanStatusCode.ERROR);
    assert.equal(failed?.attributes["error.type"], "Error");
    assert.equal(failed?.attributes["http.response.status_code"], 200);
    assert.deepEqual(
      summaries(rec).map((s) => s.attributes["o11y.outcome"]),
      ["success", "success", "failure"],
    );
  });
});

test("serverTiming adds a traceparent Server-Timing entry to HTML responses only", async () => {
  await withRecorder(async (rec) => {
    const handler = instrumentServe(
      async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/json") return Response.json({ ok: true });
        return new Response("<p>hi</p>", {
          headers: { "content-type": "Text/HTML; charset=utf-8", "server-timing": "db;dur=1" },
        });
      },
      { telemetry: rec.telemetry, serverTiming: true },
    );
    const html = await handler(new Request("http://svc/page"));
    assert.equal(await html.text(), "<p>hi</p>");
    const span = onlySpan(rec);
    const { traceId, spanId } = span.spanContext();
    assert.equal(
      html.headers.get("server-timing"),
      `db;dur=1, traceparent;desc="00-${traceId}-${spanId}-01"`,
    );
    assert.equal(html.headers.get("content-type"), "Text/HTML; charset=utf-8");

    const json = await handler(new Request("http://svc/json"));
    assert.deepEqual(await json.json(), { ok: true });
    assert.equal(json.headers.get("server-timing"), null);
  });
});

test("serverTiming rebuilds a response whose headers are immutable", async () => {
  await withRecorder(async (rec) => {
    const { server, url } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
    });
    try {
      const handler = instrumentServe(() => fetch(url), { telemetry: rec.telemetry, serverTiming: true });
      const res = await handler(new Request("http://svc/proxy"));
      assert.equal(await res.text(), "<html></html>");
      assert.match(
        res.headers.get("server-timing") ?? "",
        /^traceparent;desc="00-[0-9a-f]{32}-[0-9a-f]{16}-01"$/,
      );
      const head = await handler(new Request("http://svc/proxy", { method: "HEAD" }));
      assert.match(head.headers.get("server-timing") ?? "", /^traceparent;desc="00-[0-9a-f]{32}-/);
      await head.body?.cancel();
      assert.equal(serverSpans(rec).length, 2);
    } finally {
      await close(server);
    }
  });
});

test("the canonical line carries the record and Go's attributes in Go's order, inside the span", async () => {
  await withRecorder(async (rec) => {
    const handler = instrumentServe(
      async (req) => {
        if (req.method === "POST") {
          currentRecord().set({ "app.user.tier": "gold" });
          currentRecord().add("app.items", 2);
        }
        return new Response("ok", { status: 201 });
      },
      { telemetry: rec.telemetry, canonicalLine: true, route: () => "/orders" },
    );
    await (await handler(new Request("http://svc/orders", { method: "POST", body: "{}" }))).text();
    await (await handler(new Request("http://svc/orders", { method: "PURGE" }))).text();
    const [post, purge] = summaries(rec);
    const span = serverSpans(rec)[0];
    assert.deepEqual(
      Object.keys(post?.attributes ?? {}).filter((k) => k !== "event.name"),
      [
        "app.user.tier",
        "app.items",
        "http.request.method",
        "http.response.status_code",
        "o11y.outcome",
        "o11y.duration",
        "http.route",
      ],
    );
    assert.equal(post?.attributes["app.user.tier"], "gold");
    assert.equal(post?.attributes["app.items"], 2);
    assert.equal(post?.attributes["http.request.method"], "POST");
    assert.equal(post?.attributes["http.response.status_code"], 201);
    assert.equal(post?.attributes["o11y.outcome"], "success");
    assert.equal(typeof post?.attributes["o11y.duration"], "number");
    assert.equal(post?.attributes["http.route"], "/orders");
    assert.equal(post?.traceId, span?.spanContext().traceId);
    assert.equal(post?.spanId, span?.spanContext().spanId);
    assert.deepEqual(
      Object.keys(purge?.attributes ?? {}).filter((k) => k !== "event.name"),
      [
        "http.request.method",
        "http.request.method_original",
        "http.response.status_code",
        "o11y.outcome",
        "o11y.duration",
        "http.route",
      ],
    );
    assert.equal(purge?.attributes["http.request.method_original"], "PURGE");
  });
});

test("without a telemetry the canonical line is a silent no-op", async () => {
  await withRecorder(async (rec) => {
    const handler = instrumentServe(ok, { canonicalLine: true });
    await (await handler(new Request("http://svc/"))).text();
    assert.deepEqual(summaries(rec), []);
  });
});

test("ignored paths pass straight through, and a malformed pattern never matches", async () => {
  await withRecorder(async (rec) => {
    let calls = 0;
    const handler = instrumentServe(
      async () => {
        calls++;
        return new Response("ok");
      },
      { telemetry: rec.telemetry, canonicalLine: true, ignorePaths: ["/healthz", "/debug/*", "["] },
    );
    for (const path of ["/healthz", "/debug/pprof", "/["])
      await (await handler(new Request(`http://svc${path}`))).text();
    assert.equal(calls, 3);
    assert.deepEqual(
      serverSpans(rec).map((s) => s.attributes["url.path"]),
      ["/["],
    );
    assert.equal(summaries(rec).length, 1);
    assert.equal((await durationPoints(rec))[0]?.value.count, 1);
  });
});

test("the triangle closes and the request conforms to the spec", async () => {
  await withRecorder(async (rec) => {
    const handler = instrumentServe(
      async () => {
        rec.telemetry.logger.info("serving", { "app.count": 1 });
        return new Response("ok");
      },
      { telemetry: rec.telemetry, canonicalLine: true, route: () => "/" },
    );
    await (await handler(new Request("http://svc/"))).text();
    await rec.assertTriangle({ metric: DURATION });
    rec.assertCorrelated();
    await rec.assertConforms();
  });
});

test("without a telemetry the global tracer, meter and propagator are used, resolved per request", async () => {
  await withRecorder(async (rec) => {
    const handler = instrumentServe(ok);
    // Built before the globals exist, as a module-level wrapper is.
    trace.setGlobalTracerProvider(rec.telemetry.tracerProvider);
    metrics.setGlobalMeterProvider(rec.telemetry.meterProvider);
    propagation.setGlobalPropagator(rec.telemetry.propagator);
    try {
      await (await handler(new Request("http://svc/", { headers: { traceparent: TRACEPARENT } }))).text();
    } finally {
      trace.disable();
      metrics.disable();
      propagation.disable();
    }
    assert.equal(onlySpan(rec).spanContext().traceId, INBOUND_TRACE);
    assert.equal((await durationPoints(rec))[0]?.value.count, 1);
  });
});

test("extra handler arguments pass through and the active context outside is untouched", async () => {
  await withRecorder(async (rec) => {
    const seen: unknown[] = [];
    const handler = instrumentServe(
      async (_req: Request, server: string, n: number) => {
        seen.push(server, n);
        return new Response("ok");
      },
      { telemetry: rec.telemetry },
    );
    const before: Context = context.active();
    await (await handler(new Request("http://svc/"), "srv", 7)).text();
    assert.deepEqual(seen, ["srv", 7]);
    assert.equal(context.active(), before);
  });
});

async function exerciseServer(
  rec: Recorder,
  base: string,
): Promise<{ page: Response; text: string; span: ReadableSpan | undefined }> {
  const page = await fetch(`${base}/projects/42`, { headers: { traceparent: TRACEPARENT } });
  const text = await page.text();
  // The server ends the span after the last body chunk, which can land just after the client sees it.
  for (let i = 0; i < 100 && serverSpans(rec).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  return { page, text, span: serverSpans(rec)[0] };
}

function streamingApp(rec: Recorder) {
  return instrumentServe(
    async () => {
      rec.telemetry.logger.info("page");
      let n = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((r) => setTimeout(r, 5));
            if (n++ < 3) controller.enqueue(new TextEncoder().encode(`<p>${n}</p>`));
            else controller.close();
          },
        }),
        { headers: { "content-type": "text/html" } },
      );
    },
    { telemetry: rec.telemetry, route: () => "/projects/:id", serverTiming: true, canonicalLine: true },
  );
}

test("under a node:http adapter the span, Server-Timing and the streamed body work end to end", async () => {
  await withRecorder(async (rec) => {
    const { server, url } = await listen(nodeListener(streamingApp(rec)));
    try {
      const { page, text, span } = await exerciseServer(rec, url);
      assert.equal(text, "<p>1</p><p>2</p><p>3</p>");
      assert.equal(span?.name, "GET /projects/:id");
      assert.equal(span?.spanContext().traceId, INBOUND_TRACE);
      assert.equal(
        page.headers.get("server-timing"),
        `traceparent;desc="00-${INBOUND_TRACE}-${span?.spanContext().spanId}-0${TraceFlags.SAMPLED}"`,
      );
      await rec.assertTriangle({ metric: DURATION });
      assert.equal(summaries(rec)[0]?.traceId, INBOUND_TRACE);
    } finally {
      await close(server);
    }
  });
});

test("under Bun.serve the span, Server-Timing and the streamed body work end to end", {
  skip: !IS_BUN,
}, async () => {
  await withRecorder(async (rec) => {
    const app = streamingApp(rec);
    const server = bun?.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app(req) });
    assert.ok(server !== undefined);
    try {
      const { page, text, span } = await exerciseServer(rec, `http://127.0.0.1:${server.port}`);
      assert.equal(text, "<p>1</p><p>2</p><p>3</p>");
      assert.equal(span?.name, "GET /projects/:id");
      assert.equal(span?.spanContext().traceId, INBOUND_TRACE);
      assert.equal(
        page.headers.get("server-timing"),
        `traceparent;desc="00-${INBOUND_TRACE}-${span?.spanContext().spanId}-01"`,
      );
      await rec.assertTriangle({ metric: DURATION });
      assert.equal(summaries(rec)[0]?.traceId, INBOUND_TRACE);
    } finally {
      await server.stop(true);
    }
  });
});

test("under Bun.serve an async generator body still ends the span in its context (oven-sh/bun#24199)", {
  skip: !IS_BUN,
}, async () => {
  await withRecorder(async (rec) => {
    const app = instrumentServe(
      async () => {
        async function* body(): AsyncGenerator<string> {
          yield "a";
          await new Promise((r) => setTimeout(r, 5));
          yield "b";
        }
        return new Response(body() as unknown as ReadableStream);
      },
      { telemetry: rec.telemetry, canonicalLine: true, watchBody: () => true },
    );
    const server = bun?.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app(req) });
    assert.ok(server !== undefined);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/gen`, {
        headers: { traceparent: TRACEPARENT },
      });
      assert.equal(await res.text(), "ab");
      for (let i = 0; i < 100 && serverSpans(rec).length === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      const span = onlySpan(rec);
      assert.equal(span.spanContext().traceId, INBOUND_TRACE);
      const [summary] = summaries(rec);
      assert.equal(summary?.traceId, INBOUND_TRACE);
      assert.equal(summary?.spanId, span.spanContext().spanId);
      const exemplars = await rec.exemplars(DURATION);
      assert.equal(exemplars[0]?.spanId, span.spanContext().spanId);
    } finally {
      await server.stop(true);
    }
  });
});

/**
 * Serves app under Bun.serve twice, as is and wrapped by instrumentServe with opts, and runs fn with
 * both base URLs, so a test can compare what the wrapper changes on the wire.
 */
async function withBunServers(
  app: (req: Request) => Promise<Response>,
  opts: ServeOptions,
  fn: (plain: string, instrumented: string) => Promise<void>,
): Promise<void> {
  assert.ok(bun !== undefined);
  const wrapped = instrumentServe(app, opts);
  const plain = bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app(req) });
  const instrumented = bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => wrapped(req) });
  try {
    await fn(`http://127.0.0.1:${plain.port}`, `http://127.0.0.1:${instrumented.port}`);
  } finally {
    await plain.stop(true);
    await instrumented.stop(true);
  }
}

async function tempFile(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "libo11y-serve-"));
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

test("under Bun.serve the implicit content-type of Blob, file and form bodies survives, watched or not", {
  skip: !IS_BUN,
}, async () => {
  await withRecorder(async (rec) => {
    const script = await tempFile("app.js", "export const answer = 42;\n");
    const app = async (req: Request): Promise<Response> => {
      const path = new URL(req.url).pathname;
      if (path === "/blob") return new Response(new Blob(["a{}"], { type: "text/css" }));
      if (path === "/file") return new Response(bun?.file(script));
      return new Response(new URLSearchParams({ a: "1" }));
    };
    for (const watchBody of [undefined, () => true]) {
      const opts: ServeOptions = {
        telemetry: rec.telemetry,
        ...(watchBody === undefined ? {} : { watchBody }),
      };
      await withBunServers(app, opts, async (plain, instrumented) => {
        for (const path of ["/blob", "/file", "/params"]) {
          const want = await fetch(`${plain}${path}`);
          const got = await fetch(`${instrumented}${path}`);
          assert.equal(got.headers.get("content-type"), want.headers.get("content-type"), path);
          assert.equal(await got.text(), await want.text(), path);
        }
      });
    }
  });
});

async function waitForServerSpans(rec: Recorder, n: number): Promise<ReadableSpan[]> {
  for (let i = 0; i < 100 && serverSpans(rec).length < n; i++) await new Promise((r) => setTimeout(r, 10));
  return serverSpans(rec);
}

test("under Bun.serve HEAD requests and bodiless statuses end the span when the handler returns", {
  skip: !IS_BUN,
}, async () => {
  await withRecorder(async (rec) => {
    const app = async (req: Request): Promise<Response> => {
      const path = new URL(req.url).pathname;
      if (path === "/304") return new Response(null, { status: 304, headers: { etag: '"a"' } });
      if (path === "/204") return new Response(null, { status: 204 });
      if (path === "/stream") {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode("<p>"));
            },
          }),
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("hello", { headers: { "content-type": "text/html" } });
    };
    await withBunServers(
      app,
      { telemetry: rec.telemetry, serverTiming: true },
      async (plain, instrumented) => {
        const want = await fetch(`${plain}/text`, { method: "HEAD" });
        const got = await fetch(`${instrumented}/text`, { method: "HEAD" });
        assert.equal(got.headers.get("content-length"), want.headers.get("content-length"));
        assert.match(got.headers.get("server-timing") ?? "", /^traceparent;desc="00-[0-9a-f]{32}-/);
        await fetch(`${instrumented}/stream`, { method: "HEAD" });
        assert.equal((await fetch(`${instrumented}/304`)).status, 304);
        assert.equal((await fetch(`${instrumented}/204`)).status, 204);
      },
    );
    const spans = await waitForServerSpans(rec, 4);
    assert.deepEqual(
      spans.map((s) => [s.attributes["http.request.method"], s.attributes["http.response.status_code"]]),
      [
        ["HEAD", 200],
        ["HEAD", 200],
        ["GET", 304],
        ["GET", 204],
      ],
    );
    const points = await durationPoints(rec);
    assert.equal(points.filter((p) => p.attributes["http.request.method"] === "HEAD")[0]?.value.count, 2);
  });
});

test("by default only HTML and event streams are watched: other bodies end the request when the handler returns", async () => {
  await withRecorder(async (rec) => {
    const handler = instrumentServe(
      async (req) => {
        const type = new URL(req.url).searchParams.get("type") ?? "";
        return new Response("body", { headers: { "content-type": type } });
      },
      { telemetry: rec.telemetry },
    );
    const types = ["application/json", "TEXT/HTML; charset=utf-8", "text/event-stream", "text/plain"];
    const responses: Response[] = [];
    for (const type of types) {
      responses.push(await handler(new Request(`http://svc/?type=${encodeURIComponent(type)}`)));
    }
    assert.deepEqual(
      serverSpans(rec).map((s) => s.attributes["url.path"]),
      ["/", "/"],
      "only the JSON and plain text requests ended before their bodies were read",
    );
    for (const res of responses) assert.equal(await res.text(), "body");
    assert.equal(serverSpans(rec).length, 4);
  });
});

test("watchBody decides which responses are watched, and a throwing one watches nothing", async () => {
  await withRecorder(async (rec) => {
    const seen: string[] = [];
    const handler = instrumentServe(
      async (req) => new Response(new URL(req.url).pathname, { headers: { "content-type": "text/html" } }),
      {
        telemetry: rec.telemetry,
        watchBody: (res) => {
          seen.push(res.headers.get("content-type") ?? "");
          if (res.status === 200 && seen.length === 2) throw new Error("predicate broke");
          return false;
        },
      },
    );
    const first = await handler(new Request("http://svc/a"));
    assert.equal(serverSpans(rec).length, 1, "an unwatched response ends the request at once");
    const second = await handler(new Request("http://svc/b"));
    assert.equal(serverSpans(rec).length, 2, "a throwing predicate watches nothing");
    assert.equal(await first.text(), "/a");
    assert.equal(await second.text(), "/b");
    assert.deepEqual(seen, ["text/html", "text/html"]);
  });
});

test("under Bun.serve unwatched bodies keep their length and HTML streams are still watched", {
  skip: !IS_BUN,
}, async () => {
  await withRecorder(async (rec) => {
    const big = "y".repeat(1_000_000);
    const file = await tempFile("data.bin", "z".repeat(100_000));
    let cancelled = false;
    const app = async (req: Request): Promise<Response> => {
      const path = new URL(req.url).pathname;
      if (path === "/big") return new Response(big);
      if (path === "/file") return new Response(bun?.file(file));
      let n = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((r) => setTimeout(r, 20));
            if (path === "/endless" || n++ < 3) controller.enqueue(new TextEncoder().encode("<p>"));
            else controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/html" } },
      );
    };
    await withBunServers(app, { telemetry: rec.telemetry }, async (plain, instrumented) => {
      for (const path of ["/big", "/file"]) {
        const want = await fetch(`${plain}${path}`);
        const got = await fetch(`${instrumented}${path}`);
        assert.ok(want.headers.get("content-length") !== null, path);
        assert.equal(got.headers.get("content-length"), want.headers.get("content-length"), path);
        assert.equal(got.headers.get("transfer-encoding"), null, path);
        assert.equal((await got.text()).length, (await want.text()).length, path);
      }
      const page = await fetch(`${instrumented}/page`);
      const reader = page.body?.getReader();
      assert.ok(reader !== undefined);
      await reader.read();
      assert.equal(serverSpans(rec).length, 2, "the HTML request ended before its body was read");
      while (!(await reader.read()).done);
      const spans = await waitForServerSpans(rec, 3);
      assert.equal(spans[2]?.attributes["url.path"], "/page");

      const abort = new AbortController();
      const endless = await fetch(`${instrumented}/endless`, { signal: abort.signal });
      await endless.body?.getReader().read();
      abort.abort();
      await waitForServerSpans(rec, 4);
      for (let i = 0; i < 100 && !cancelled; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(serverSpans(rec)[3]?.attributes["url.path"], "/endless");
      assert.ok(cancelled, "the source of a cancelled HTML stream was cancelled");
    });
  });
});

test("setRoute names the request from inside the handler, over the route option, for the span, metric and summary", async () => {
  await withRecorder(async (rec) => {
    const handler = instrumentServe(
      async (req) => {
        await new Promise((r) => setTimeout(r, 1));
        const path = new URL(req.url).pathname;
        if (path.startsWith("/projects/")) setRoute("/projects/:id");
        if (path === "/verbatim") setRoute("POST /verbatim");
        return new Response("ok");
      },
      { telemetry: rec.telemetry, canonicalLine: true, route: () => "/fallback" },
    );
    await (await handler(new Request("http://svc/projects/7"))).text();
    await (await handler(new Request("http://svc/verbatim", { method: "POST", body: "x" }))).text();
    await (await handler(new Request("http://svc/other"))).text();
    const [routed, verbatim, other] = serverSpans(rec);
    assert.equal(routed?.name, "GET /projects/:id");
    assert.equal(routed?.attributes["http.route"], "/projects/:id");
    assert.equal(verbatim?.name, "POST /verbatim");
    assert.equal(verbatim?.attributes["http.route"], "/verbatim");
    assert.equal(other?.name, "GET /fallback");
    assert.equal(other?.attributes["http.route"], "/fallback");
    assert.deepEqual((await durationPoints(rec)).map((p) => p.attributes["http.route"]).sort(), [
      "/fallback",
      "/projects/:id",
      "/verbatim",
    ]);
    assert.deepEqual(
      summaries(rec).map((s) => s.attributes["http.route"]),
      ["/projects/:id", "/verbatim", "/fallback"],
    );
  });
});

test("setRoute without a route option names an unrouted request, and outside a request it does nothing", async () => {
  await withRecorder(async (rec) => {
    setRoute("/outside");
    const handler = instrumentServe(
      async () => {
        setRoute("/inside");
        return new Response("ok");
      },
      { telemetry: rec.telemetry },
    );
    await (await handler(new Request("http://svc/x"))).text();
    setRoute("/after");
    const span = onlySpan(rec);
    assert.equal(span.name, "GET /inside");
    assert.equal(span.attributes["http.route"], "/inside");
    assert.equal((await durationPoints(rec))[0]?.attributes["http.route"], "/inside");
  });
});
