/**
 * installXhrInstrumentation over a minimal fake XMLHttpRequest installed on globalThis for each
 * test: the span as for fetch, injection by setRequestHeader under the propagate rule, status and
 * failure handling, synchronous requests, consent, and restoring the prototype.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Telemetry } from "@libo11y/core";
import { createRecorder, type Recorder } from "@libo11y/test";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { Consent, ConsentState } from "../contracts/consent.ts";
import type { HttpInstrumentationOptions, HttpRequestInfo } from "../options.ts";
import { DURATION_METRIC } from "./http-common.ts";
import { installXhrInstrumentation } from "./xhr.ts";

const PAGE = "https://app.example.com/page";

/** Just enough of XMLHttpRequest: open, setRequestHeader, send, events, status and readyState. */
class FakeXhr extends EventTarget {
  readyState = 0;
  status = 0;
  method = "";
  url = "";
  async = true;
  headers: [string, string][] = [];
  sends = 0;
  /** A synchronous send answers with this status, or throws a NetworkError when it is "throw". */
  syncResult: number | "throw" = 200;
  private sent = false;

  open(method: string, url: string | URL, ...rest: [async?: boolean]): void {
    this.method = method;
    this.url = String(url);
    // As the real one: open(method, url) is async; an explicit undefined third argument is false.
    this.async = rest.length === 0 ? true : Boolean(rest[0]);
    this.readyState = 1;
    this.headers = [];
    this.sent = false;
  }

  setRequestHeader(name: string, value: string): void {
    if (this.readyState !== 1 || this.sent) throw new DOMException("not opened", "InvalidStateError");
    this.headers.push([name, value]);
  }

  send(_body?: unknown): void {
    if (this.readyState !== 1 || this.sent) throw new DOMException("not opened", "InvalidStateError");
    this.sent = true;
    this.sends++;
    if (!this.async) {
      if (this.syncResult === "throw") {
        this.readyState = 4;
        throw new DOMException("sync failed", "NetworkError");
      }
      this.respond(this.syncResult);
    }
  }

  header(name: string): string | undefined {
    return this.headers.find(([k]) => k === name)?.[1];
  }

  respond(status: number): void {
    this.status = status;
    this.readyState = 4;
    this.dispatchEvent(new Event("load"));
    this.dispatchEvent(new Event("loadend"));
  }

  fail(type: "error" | "abort" | "timeout"): void {
    this.status = 0;
    this.readyState = 4;
    this.dispatchEvent(new Event(type));
    this.dispatchEvent(new Event("loadend"));
  }
}

function settableConsent(initial: ConsentState): Consent & { set(s: ConsentState): void } {
  let state = initial;
  return {
    state: () => state,
    grant: () => {
      state = "granted";
      return state;
    },
    revoke: async () => {},
    subscribe: () => () => {},
    set: (s) => {
      state = s;
    },
  };
}

function withConsent(telemetry: Telemetry, consent: Consent): Telemetry {
  return Object.assign(Object.create(telemetry) as object, { consent }) as unknown as Telemetry;
}

type Patched = { install: (opts?: HttpInstrumentationOptions) => () => void; rec: Recorder };

/**
 * Runs fn with FakeXhr as globalThis.XMLHttpRequest and globalThis.location at PAGE, and a
 * recorder; restores the globals and FakeXhr's prototype afterwards.
 */
async function withXhr(fn: (p: Patched) => Promise<void> | void): Promise<void> {
  const rec = await createRecorder({ serviceName: "web-xhr-test" });
  const g = globalThis as { XMLHttpRequest?: unknown; location?: unknown };
  const beforeXhr = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  const beforeLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const { open, send, setRequestHeader } = FakeXhr.prototype;
  const uninstalls: (() => void)[] = [];
  Object.defineProperty(globalThis, "XMLHttpRequest", { value: FakeXhr, configurable: true, writable: true });
  Object.defineProperty(globalThis, "location", {
    value: { href: PAGE, origin: new URL(PAGE).origin },
    configurable: true,
    writable: true,
  });
  try {
    await fn({
      rec,
      install: (opts = {}) => {
        const u = installXhrInstrumentation({ telemetry: rec.telemetry, ...opts });
        uninstalls.push(u);
        return u;
      },
    });
  } finally {
    for (const u of uninstalls) u();
    FakeXhr.prototype.open = open;
    FakeXhr.prototype.send = send;
    FakeXhr.prototype.setRequestHeader = setRequestHeader;
    if (beforeXhr !== undefined) Object.defineProperty(globalThis, "XMLHttpRequest", beforeXhr);
    else delete g.XMLHttpRequest;
    if (beforeLocation !== undefined) Object.defineProperty(globalThis, "location", beforeLocation);
    else delete g.location;
    await rec.shutdown();
  }
}

function clientSpans(rec: Recorder): ReadableSpan[] {
  return rec.spans().filter((s) => s.kind === SpanKind.CLIENT);
}

function inParent<T>(rec: Recorder, fn: () => T): { parent: ReadableSpan; result: T } {
  const span = rec.telemetry.tracerProvider.getTracer("app").startSpan("parent");
  const result = context.with(trace.setSpan(context.active(), span), fn);
  span.end();
  return { parent: rec.spans().find((s) => s.name === "parent") as ReadableSpan, result };
}

test("an async same-origin request gets a CLIENT span ended on loadend, with context injected", async () => {
  await withXhr(async ({ rec, install }) => {
    install();
    const xhr = new FakeXhr();
    const { parent } = inParent(rec, () => {
      xhr.open("get", "/api/items?x=1");
      xhr.send();
    });
    assert.equal(xhr.async, true, "open's arity is preserved");
    assert.equal(xhr.url, "/api/items?x=1");
    assert.equal(clientSpans(rec).length, 0, "the span is open until loadend");
    xhr.respond(200);
    const [span] = clientSpans(rec);
    assert.ok(span);
    assert.equal(span.name, "GET");
    assert.equal(span.parentSpanContext?.spanId, parent.spanContext().spanId);
    const { traceId, spanId } = span.spanContext();
    assert.equal(xhr.header("traceparent"), `00-${traceId}-${spanId}-01`);
    // XHR sends "get" as GET, as fetch does, so there is no method_original.
    assert.deepEqual(span.attributes, {
      "http.request.method": "GET",
      "server.address": "app.example.com",
      "server.port": 443,
      "url.full": "https://app.example.com/api/items?x=1",
      "http.response.status_code": 200,
    });
    assert.equal(span.status.code, SpanStatusCode.UNSET);
    const rm = await rec.metrics();
    const metric = rm.scopeMetrics
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === DURATION_METRIC);
    assert.equal(metric?.dataPoints.length, 1);
    assert.deepEqual(metric?.dataPoints[0]?.attributes, {
      "http.request.method": "GET",
      "server.address": "app.example.com",
      "server.port": 443,
      "http.response.status_code": 200,
    });
  });
});

test("a traceparent the caller set is kept, not doubled, and the request still gets its span", async () => {
  await withXhr(async ({ rec, install }) => {
    install();
    const callerParent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const xhr = new FakeXhr();
    inParent(rec, () => {
      xhr.open("GET", "/api/items");
      xhr.setRequestHeader("TraceParent", callerParent);
      xhr.send();
    });
    xhr.respond(200);
    const traceparents = xhr.headers.filter(([k]) => k.toLowerCase() === "traceparent");
    assert.deepEqual(traceparents, [["TraceParent", callerParent]]);
    assert.deepEqual(
      xhr.headers.filter(([k]) => ["tracestate", "baggage"].includes(k.toLowerCase())),
      [],
      "the caller's context is not mixed with this one",
    );
    const [span] = clientSpans(rec);
    assert.ok(span);
    assert.equal(span.attributes["http.response.status_code"], 200);
  });
});

test("a caller's traceparent counts only until the next open", async () => {
  await withXhr(async ({ rec, install }) => {
    install();
    const xhr = new FakeXhr();
    xhr.open("GET", "/api/a");
    xhr.setRequestHeader("traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    xhr.send();
    xhr.respond(200);
    xhr.open("GET", "/api/b");
    xhr.send();
    xhr.respond(200);
    const second = clientSpans(rec)[1];
    assert.ok(second);
    const { traceId, spanId } = second.spanContext();
    assert.equal(xhr.header("traceparent"), `00-${traceId}-${spanId}-01`);
  });
});

test("a cross-origin request gets no context unless propagateTo allows its origin", async () => {
  await withXhr(({ rec, install }) => {
    install({ propagateTo: ["https://api.example.com"] });
    const urls = ["https://api.example.com/x", "https://other.example.org/y"];
    const xhrs = urls.map((url) => {
      const xhr = new FakeXhr();
      inParent(rec, () => {
        xhr.open("POST", url);
        xhr.send("{}");
      });
      xhr.respond(201);
      return xhr;
    });
    assert.deepEqual(
      xhrs.map((x) => x.header("traceparent") !== undefined),
      [true, false],
    );
    assert.equal(clientSpans(rec).length, 2);
  });
});

test("while consent is closed or for an ignored URL there is no span and no header", async () => {
  await withXhr(({ rec, install }) => {
    const consent = settableConsent("pending");
    install({ telemetry: withConsent(rec.telemetry, consent), ignoreUrls: [/\/otlp\//] });
    const run = (url: string): FakeXhr => {
      const xhr = new FakeXhr();
      inParent(rec, () => {
        xhr.open("GET", url);
        xhr.send();
      });
      xhr.respond(200);
      return xhr;
    };
    const pending = run("/a");
    consent.set("denied");
    const denied = run("/b");
    consent.set("granted");
    const ignored = run("/otlp/v1/traces");
    const recorded = run("/c");
    assert.deepEqual(
      [pending, denied, ignored, recorded].map((x) => x.header("traceparent") !== undefined),
      [false, false, false, true],
    );
    assert.equal(clientSpans(rec).length, 1);
    assert.equal(clientSpans(rec)[0]?.attributes["url.full"], "https://app.example.com/c");
  });
});

test("status 0 is a failure typed by the event, and 4xx and 5xx set error.type to the status", async () => {
  await withXhr(({ rec, install }) => {
    install();
    for (const outcome of ["error", "abort", "timeout", 500, 404] as const) {
      const xhr = new FakeXhr();
      xhr.open("GET", `/r/${outcome}`);
      xhr.send();
      if (typeof outcome === "number") xhr.respond(outcome);
      else xhr.fail(outcome);
    }
    const spans = clientSpans(rec);
    assert.deepEqual(
      spans.map((s) => s.attributes["error.type"]),
      ["error", "abort", "timeout", "500", "404"],
    );
    assert.ok(spans.every((s) => s.status.code === SpanStatusCode.ERROR));
    assert.equal(spans[0]?.attributes["http.response.status_code"], undefined);
    assert.equal(spans[3]?.attributes["http.response.status_code"], 500);
  });
});

test("a synchronous request is instrumented the same way, and a throwing one ends its span", async () => {
  await withXhr(({ rec, install }) => {
    install();
    const ok = new FakeXhr();
    ok.open("GET", "/sync", false);
    ok.send();
    assert.equal(ok.async, false);
    assert.ok(ok.header("traceparent") !== undefined);
    const failing = new FakeXhr();
    failing.syncResult = "throw";
    failing.open("GET", "/sync-fail", false);
    assert.throws(() => failing.send(), { name: "NetworkError" });
    const [good, bad] = clientSpans(rec);
    assert.equal(good?.attributes["http.response.status_code"], 200);
    assert.equal(bad?.attributes["error.type"], "NetworkError");
    assert.equal(bad?.status.code, SpanStatusCode.ERROR);
    assert.ok(bad?.events.some((e) => e.name === "exception"));
  });
});

test("onStart runs before send with kind xhr, and a throwing onStart is isolated", async () => {
  await withXhr(({ rec, install }) => {
    const seen: { request: HttpRequestInfo; sends: number }[] = [];
    let xhr = new FakeXhr();
    install({
      onStart: (span, request) => {
        seen.push({ request, sends: xhr.sends });
        span.updateName("PUT /items/:id");
        if (request.url.pathname === "/boom") throw new Error("hook broke");
      },
    });
    xhr.open("put", "/items/7");
    xhr.send("x");
    xhr.respond(204);
    xhr = new FakeXhr();
    xhr.open("GET", "/boom");
    xhr.send();
    xhr.respond(200);
    assert.equal(seen[0]?.sends, 0);
    assert.equal(seen[0]?.request.kind, "xhr");
    assert.equal(seen[0]?.request.method, "PUT");
    assert.equal(seen[0]?.request.url.href, "https://app.example.com/items/7");
    assert.equal(xhr.sends, 1);
    assert.deepEqual(
      clientSpans(rec).map((s) => s.name),
      ["PUT /items/:id", "PUT /items/:id"],
    );
  });
});

test("reopening an instance in flight ends the old span as aborted, and the next request gets its own", async () => {
  await withXhr(({ rec, install }) => {
    install();
    const xhr = new FakeXhr();
    xhr.open("GET", "/first");
    xhr.send();
    xhr.open("GET", "/second");
    xhr.send();
    xhr.respond(200);
    const spans = clientSpans(rec);
    assert.equal(spans.length, 2);
    assert.equal(spans[0]?.attributes["error.type"], "abort");
    assert.equal(spans[1]?.attributes["url.full"], "https://app.example.com/second");
    assert.equal(spans[1]?.attributes["http.response.status_code"], 200);
  });
});

test("a request opened before install is sent uninstrumented", async () => {
  await withXhr(({ rec, install }) => {
    const xhr = new FakeXhr();
    xhr.open("GET", "/early");
    install();
    xhr.send();
    xhr.respond(200);
    assert.equal(clientSpans(rec).length, 0);
    assert.equal(xhr.header("traceparent"), undefined);
  });
});

test("uninstall restores the prototype, a second install is a no-op, and no XMLHttpRequest is a no-op", async () => {
  await withXhr(({ rec, install }) => {
    const { open, send } = FakeXhr.prototype;
    const uninstall = install();
    assert.notEqual(FakeXhr.prototype.open, open);
    const patchedSend = FakeXhr.prototype.send;
    const again = install();
    assert.equal(FakeXhr.prototype.send, patchedSend, "a second install does not wrap again");
    again();
    assert.equal(FakeXhr.prototype.send, patchedSend);
    uninstall();
    assert.equal(FakeXhr.prototype.open, open);
    assert.equal(FakeXhr.prototype.send, send);
    const xhr = new FakeXhr();
    xhr.open("GET", "/after");
    xhr.send();
    xhr.respond(200);
    assert.equal(clientSpans(rec).length, 0);

    delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    const none = installXhrInstrumentation({ telemetry: rec.telemetry });
    none();
  });
});

test("after uninstall a patch still reached through a later wrapper passes straight through", async () => {
  await withXhr(({ rec, install }) => {
    const uninstall = install();
    // Another library (zone.js, say) wraps open and send after us, so uninstall cannot restore them.
    const ours = { open: FakeXhr.prototype.open, send: FakeXhr.prototype.send };
    FakeXhr.prototype.open = function (this: FakeXhr, ...args: unknown[]) {
      return Reflect.apply(ours.open, this, args);
    } as typeof FakeXhr.prototype.open;
    FakeXhr.prototype.send = function (this: FakeXhr, ...args: unknown[]) {
      return Reflect.apply(ours.send, this, args);
    } as typeof FakeXhr.prototype.send;
    uninstall();
    const xhr = new FakeXhr();
    xhr.open("GET", "/after-uninstall");
    xhr.send();
    xhr.respond(200);
    assert.equal(clientSpans(rec).length, 0, "an uninstalled patch records nothing");
    assert.equal(xhr.header("traceparent"), undefined, "and injects nothing");

    install();
    const again = new FakeXhr();
    again.open("GET", "/reinstalled");
    again.send();
    again.respond(200);
    assert.equal(clientSpans(rec).length, 1, "a reinstall under the wrapper records one span, not two");
  });
});

test("data:, blob: and other non-HTTP URLs get no span and no context", async () => {
  await withXhr(({ rec, install }) => {
    install({ propagateTo: [/.*/] });
    for (const url of ["data:text/plain,secret", "blob:https://app.example.com/0b5c2a52", "about:blank"]) {
      const xhr = new FakeXhr();
      xhr.open("GET", url);
      xhr.send();
      xhr.respond(200);
      assert.equal(xhr.header("traceparent"), undefined, url);
    }
    assert.equal(clientSpans(rec).length, 0);
  });
});

test("a send the XHR refuses (in flight, or done without a reopen) records no span of its own", async () => {
  await withXhr(({ rec, install }) => {
    install();
    const xhr = new FakeXhr();
    xhr.open("GET", "/first");
    xhr.send();
    assert.throws(() => xhr.send(), { name: "InvalidStateError" });
    assert.equal(clientSpans(rec).length, 0, "the refused send starts no span");
    xhr.open("GET", "/second");
    assert.equal(clientSpans(rec).length, 1, "reopening still ends the request in flight");
    assert.equal(clientSpans(rec)[0]?.attributes["url.full"], "https://app.example.com/first");
    assert.equal(clientSpans(rec)[0]?.attributes["error.type"], "abort");
    xhr.send();
    xhr.respond(200);
    assert.throws(() => xhr.send(), { name: "InvalidStateError" });
    assert.equal(clientSpans(rec).length, 2, "a send after loadend without a reopen starts no span");
  });
});
