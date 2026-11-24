/**
 * setup and createTelemetry on the server platform. setup installs globals, so each scenario runs in
 * a child process of the same runtime (test-support/setup-child.ts) against an in-process OTLP sink.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type OtlpSink, startOtlpSink } from "@libo11y/test";
import { createTelemetry } from "./setup.ts";
import { clearedOtelEnv } from "./test-support/env.ts";

const IS_BUN = "Bun" in globalThis;
const CHILD = fileURLToPath(new URL("./test-support/setup-child.ts", import.meta.url));

type Json = Record<string, unknown>;

interface ChildRun {
  readonly lines: readonly Json[];
  readonly result: Json;
  readonly stderr: string;
}

function runChild(scenario: string, env: Record<string, string>): Promise<ChildRun> {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...clearedOtelEnv(), ...env };
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CHILD, scenario],
      { env: childEnv as NodeJS.ProcessEnv, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err !== null) {
          reject(new Error(`${scenario} failed: ${err.message}\n${stdout}\n${stderr}`));
          return;
        }
        const out = stdout.trimEnd().split("\n");
        const last = out.at(-1) ?? "";
        if (!last.startsWith("RESULT ")) {
          reject(new Error(`${scenario} printed no result:\n${stdout}\n${stderr}`));
          return;
        }
        const lines = out.slice(0, -1).map((l) => JSON.parse(l) as Json);
        resolve({ lines, result: JSON.parse(last.slice("RESULT ".length)) as Json, stderr });
      },
    );
  });
}

async function withSink(fn: (sink: OtlpSink) => Promise<void>): Promise<void> {
  const sink = await startOtlpSink();
  try {
    await fn(sink);
  } finally {
    await sink.close();
  }
}

function records(sink: OtlpSink): Json[] {
  return (sink.logs() as Json[]).flatMap((req) =>
    (req.resourceLogs as Json[]).flatMap((rl) =>
      (rl.scopeLogs as Json[]).flatMap((sl) => sl.logRecords as Json[]),
    ),
  );
}

function spans(sink: OtlpSink): Json[] {
  return (sink.traces() as Json[]).flatMap((req) =>
    (req.resourceSpans as Json[]).flatMap((rs) =>
      (rs.scopeSpans as Json[]).flatMap((ss) => ss.spans as Json[]),
    ),
  );
}

function metricList(sink: OtlpSink): Json[] {
  return (sink.metrics() as Json[]).flatMap((req) =>
    (req.resourceMetrics as Json[]).flatMap((rm) =>
      (rm.scopeMetrics as Json[]).flatMap((sm) => sm.metrics as Json[]),
    ),
  );
}

test("setup into the sink gives the full triangle, the canary on stdout and runtime metrics", async () => {
  await withSink(async (sink) => {
    const run = await runChild("triangle", {
      OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
      OTEL_METRIC_EXPORT_INTERVAL: "100",
      SETUP_CHILD_WAIT_MILLIS: "400",
    });
    const traceId = run.result.traceId as string;
    assert.deepEqual(run.result.report, { ok: true, errors: [] });

    // The span.
    const span = spans(sink).find((s) => s.name === "GET /items");
    assert.equal(span?.traceId, traceId);
    // The log inside it, on the console and over OTLP.
    const line = run.lines.find((l) => l.msg === "listing items");
    assert.equal(line?.trace_id, traceId);
    const log = records(sink).find((r) => (r.body as Json | undefined)?.stringValue === "listing items");
    assert.equal(log?.traceId, traceId);
    // The exemplar on the metric, carrying the trace.
    const latency = metricList(sink).find((m) => m.name === "app.latency");
    const points = (latency?.histogram as { dataPoints: Json[] } | undefined)?.dataPoints ?? [];
    const exemplars = points.flatMap((p) => (p.exemplars ?? []) as Json[]);
    assert.equal(exemplars[0]?.traceId, traceId);

    // The canary reached stdout and the log pipeline.
    const canary = run.lines.find((l) => l.msg === "o11y.telemetry.configured");
    assert.ok(canary !== undefined, `no canary in ${JSON.stringify(run.lines)}`);
    assert.equal(canary["service.name"], "setup-child");
    assert.equal(canary["o11y.config.runtime_metrics"], "true");
    assert.ok(
      records(sink).some((r) => (r.body as Json | undefined)?.stringValue === "o11y.telemetry.configured"),
    );

    // The resource is the server platform's.
    const [req] = sink.traces() as Json[];
    const resource = ((req?.resourceSpans as Json[] | undefined)?.[0]?.resource as Json | undefined)
      ?.attributes as Json[] | undefined;
    const runtime = resource?.find((a) => a.key === "process.runtime.name")?.value as Json | undefined;
    assert.equal(runtime?.stringValue, IS_BUN ? "bun" : "nodejs");

    // Runtime metrics are on by default; Bun never reports event loop utilization.
    const names = new Set(metricList(sink).map((m) => m.name));
    assert.ok(names.has("nodejs.eventloop.time"), [...names].join(", "));
    assert.equal(names.has("nodejs.eventloop.utilization"), !IS_BUN);
  });
});

test("OTEL_SDK_DISABLED=true exports nothing and still logs to the console", async () => {
  await withSink(async (sink) => {
    const run = await runChild("disabled", {
      OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
      OTEL_SDK_DISABLED: "true",
    });
    assert.deepEqual(run.result.report, { ok: true, errors: [] });
    assert.ok(run.lines.some((l) => l.msg === "still on the console"));
    assert.ok(run.lines.some((l) => l.msg === "o11y.telemetry.configured"));
    assert.deepEqual(sink.requests(), []);
  });
});

test("a second setup fails with ALREADY_SETUP, and setup after shutdown works", async () => {
  await withSink(async (sink) => {
    const run = await runChild("twice", { OTEL_EXPORTER_OTLP_ENDPOINT: sink.url });
    assert.deepEqual(run.result, { second: "ALREADY_SETUP", again: true });
    assert.equal(run.lines.filter((l) => l.msg === "o11y.telemetry.configured").length, 2);
  });
});

test("createTelemetry builds on the server platform without the canary or any global", async () => {
  const telemetry = await createTelemetry({
    serviceName: "create-test",
    environment: "test",
    hermetic: true,
    console: false,
    runtimeMetrics: false,
  });
  try {
    assert.equal(telemetry.resource.attributes["process.runtime.name"], IS_BUN ? "bun" : "nodejs");
    assert.equal(telemetry.resource.attributes["service.name"], "create-test");
  } finally {
    await telemetry.shutdown();
  }
});
