import assert from "node:assert/strict";
import { test } from "node:test";
import type { HttpRequestInfo, RequestStartHook, Rum } from "@libo11y/rum";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { connectRequestNaming, rpcOf } from "./naming.ts";

const SIGN = "lor.signing.v1.SigningService/SignDocument";

test("rpcOf reads package-qualified service paths, under any base path", () => {
  assert.deepEqual(rpcOf("/lor.signing.v1.SigningService/SignDocument"), {
    service: "lor.signing.v1.SigningService",
    method: "SignDocument",
  });
  assert.deepEqual(rpcOf("/connect/lor.signing.v1.SigningService/SignDocument"), {
    service: "lor.signing.v1.SigningService",
    method: "SignDocument",
  });
  assert.equal(rpcOf("/Service/Method"), undefined);
  assert.equal(rpcOf("/api/v1/documents"), undefined);
  assert.equal(rpcOf("/a.B/c/d"), undefined);
  assert.equal(rpcOf("/a.B/"), undefined);
  assert.equal(rpcOf("/a..B/Method"), undefined);
  assert.equal(rpcOf("/1a.B/Method"), undefined);
});

/** A Rum whose onRequestStart records its hook, and a tracer whose ended spans are exported. */
function harness(): {
  readonly rum: Rum;
  readonly run: (method: string, url: string, kind?: HttpRequestInfo["kind"]) => void;
  readonly hooks: () => number;
  readonly ended: () => { name: string; attributes: Record<string, unknown> }[];
} {
  const hooks = new Set<RequestStartHook>();
  const rum = {
    onRequestStart(h: RequestStartHook) {
      hooks.add(h);
      return () => hooks.delete(h);
    },
  } as unknown as Rum;
  const exporter = new InMemorySpanExporter();
  const tracer = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }).getTracer(
    "t",
  );
  return {
    rum,
    run(method, url, kind = "fetch") {
      const span = tracer.startSpan(method);
      for (const h of hooks) h(span, { kind, method, url: new URL(url) });
      span.end();
    },
    hooks: () => hooks.size,
    ended: () => exporter.getFinishedSpans().map((s) => ({ name: s.name, attributes: { ...s.attributes } })),
  };
}

test("an RPC fetch span is named service/method with the RPC attributes", () => {
  const h = harness();
  connectRequestNaming(h.rum);
  h.run("POST", `https://app.test/${SIGN}`);
  assert.deepEqual(h.ended(), [
    { name: SIGN, attributes: { "rpc.system.name": "connectrpc", "rpc.method": SIGN } },
  ]);
});

test("a gRPC-Web transport sets rpc.system.name grpc", () => {
  const h = harness();
  connectRequestNaming(h.rum, { system: "grpc" });
  h.run("POST", `https://app.test/grpc/${SIGN}`);
  assert.equal(h.ended()[0]?.attributes["rpc.system.name"], "grpc");
});

test("a Connect GET request is an RPC; other GETs are left alone", () => {
  const h = harness();
  connectRequestNaming(h.rum);
  h.run("GET", `https://app.test/${SIGN}?connect=v1&encoding=json&message=%7B%7D`);
  h.run("GET", `https://app.test/${SIGN}`);
  assert.deepEqual(
    h.ended().map((s) => s.name),
    [SIGN, "GET"],
  );
});

test("requests outside the service allow-list and non-RPC paths are left alone", () => {
  const h = harness();
  connectRequestNaming(h.rum, { services: ["lor.signing.v1.SigningService"] });
  h.run("POST", "https://app.test/lor.other.v1.Other/Do");
  h.run("POST", "https://app.test/api/v1/documents");
  h.run("PUT", `https://app.test/${SIGN}`);
  h.run("POST", `https://app.test/${SIGN}`, "xhr");
  assert.deepEqual(
    h.ended().map((s) => s.name),
    ["POST", "POST", "PUT", SIGN],
  );
});

test("the returned function removes the hook", () => {
  const h = harness();
  const off = connectRequestNaming(h.rum);
  assert.equal(h.hooks(), 1);
  off();
  assert.equal(h.hooks(), 0);
});
