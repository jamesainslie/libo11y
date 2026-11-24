/**
 * Runs the example as its own process against an in-process OTLP sink and a stub upstream, makes
 * one request, sends SIGTERM while a second is in flight, and checks that the second finished and
 * what reached the sink: the server span, the correlated
 * log, the exemplar on http.server.request.duration, the client span to the upstream, and the
 * Server-Timing header on the page. Bun.serve exists only under Bun, so Node skips it.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startOtlpSink } from "@libo11y/test";

const SERVICE = "example-bun-server";
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

type Json = Record<string, unknown>;

function flat(requests: readonly unknown[], resource: string, scope: string, items: string): Json[] {
  return (requests as Json[]).flatMap((req) =>
    ((req[resource] ?? []) as Json[]).flatMap((r) =>
      ((r[scope] ?? []) as Json[]).flatMap((s) => (s[items] ?? []) as Json[]),
    ),
  );
}

/**
 * A stub projects API that remembers the headers it was sent. It answers for project "slow" only
 * after a delay, and calls onSlow when that request arrives.
 */
async function startUpstream(
  onSlow: () => void = () => {},
): Promise<{ url: string; seen: IncomingHttpHeaders[]; server: Server }> {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    const slow = req.url === "/projects/slow";
    if (slow) onSlow();
    setTimeout(
      () => {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ name: slow ? "Project slow" : "Project 42" }));
      },
      slow ? 500 : 0,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

/** Starts the example and resolves with its port once it logs "listening" on the console sink. */
function startExample(
  env: Record<string, string>,
): Promise<{ child: ChildProcess; port: number; lines: Json[] }> {
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OTEL_")));
  const child = spawn(process.execPath, [MAIN], {
    env: { ...ambient, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: Json[] = [];
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the example did not start:\n${stderr}`)), 20_000);
    let buffered = "";
    child.stdout?.on("data", (d: Buffer) => {
      buffered += d.toString();
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      for (const part of parts) {
        const line = JSON.parse(part) as Json;
        lines.push(line);
        if (line.msg === "listening") {
          clearTimeout(timer);
          resolve({ child, port: line["server.port"] as number, lines });
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the example exited with ${code}:\n${stderr}`));
    });
  });
}

/** Sends SIGTERM and waits for the exit code, killing the process after the timeout. */
function stop(child: ChildProcess, timeoutMillis = 15_000): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMillis);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.kill("SIGTERM");
  });
}

test("the example closes the triangle in the sink and the page carries Server-Timing", {
  skip: !("Bun" in globalThis),
  timeout: 60_000,
}, async () => {
  const sink = await startOtlpSink();
  let slowArrived: () => void = () => {};
  const slowInFlight = new Promise<void>((resolve) => {
    slowArrived = resolve;
  });
  const upstream = await startUpstream(() => slowArrived());
  let child: ChildProcess | undefined;
  try {
    const started = await startExample({
      OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=test",
      UPSTREAM_URL: upstream.url,
      PORT: "0",
    });
    child = started.child;

    const page = await fetch(`http://127.0.0.1:${started.port}/projects/42`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<h1>Project 42<\/h1>/);
    const timing = /^traceparent;desc="00-([0-9a-f]{32})-([0-9a-f]{16})-01"$/.exec(
      page.headers.get("server-timing") ?? "",
    );
    assert.ok(timing !== null, `Server-Timing ${page.headers.get("server-timing")}`);
    const [, traceId, spanId] = timing;

    // SIGTERM while a request is in flight: the server stops first and lets it finish, then the
    // telemetry shuts down with its span.
    const slow = fetch(`http://127.0.0.1:${started.port}/projects/slow`).then(async (res) => ({
      status: res.status,
      text: await res.text(),
    }));
    await slowInFlight;
    assert.equal(await stop(child), 0);
    const slowPage = await slow;
    assert.equal(slowPage.status, 200);
    assert.match(slowPage.text, /<h1>Project slow<\/h1>/);

    const spans = flat(sink.traces(), "resourceSpans", "scopeSpans", "spans");
    const serverSpans = spans.filter((s) => s.name === "GET /projects/:id");
    assert.equal(serverSpans.length, 2, "the request in flight at SIGTERM was exported too");
    const serverSpan = serverSpans.find((s) => s.traceId === traceId);
    assert.equal(serverSpan?.traceId, traceId);
    assert.equal(serverSpan?.spanId, spanId);
    const client = spans.find((s) => s.name === "GET" && s.parentSpanId === spanId);
    assert.ok(client !== undefined, `no client span under the server span: ${JSON.stringify(spans)}`);
    assert.equal(upstream.seen[0]?.traceparent, `00-${traceId}-${client.spanId}-01`);

    const logs = flat(sink.logs(), "resourceLogs", "scopeLogs", "logRecords");
    const loaded = logs.find((r) => (r.body as Json | undefined)?.stringValue === "project loaded");
    assert.equal(loaded?.traceId, traceId);
    assert.equal(loaded?.spanId, spanId);
    assert.ok(logs.some((r) => (r.body as Json | undefined)?.stringValue === "o11y.telemetry.configured"));

    const metrics = flat(sink.metrics(), "resourceMetrics", "scopeMetrics", "metrics");
    const exemplarTraces = (name: string): unknown[] =>
      metrics
        .filter((m) => m.name === name)
        .flatMap((m) => ((m.histogram as Json | undefined)?.dataPoints ?? []) as Json[])
        .flatMap((p) => (p.exemplars ?? []) as Json[])
        .map((e) => e.traceId);
    assert.ok(exemplarTraces("http.server.request.duration").includes(traceId));
    assert.ok(exemplarTraces("http.client.request.duration").includes(traceId));

    const [req] = sink.traces() as Json[];
    const resource = ((req?.resourceSpans as Json[] | undefined)?.[0]?.resource as Json | undefined)
      ?.attributes as Json[] | undefined;
    assert.equal(
      (resource?.find((a) => a.key === "service.name")?.value as Json | undefined)?.stringValue,
      SERVICE,
    );
  } finally {
    if (child !== undefined) await stop(child, 2_000);
    await new Promise((resolve) => upstream.server.close(resolve));
    await sink.close();
  }
});
