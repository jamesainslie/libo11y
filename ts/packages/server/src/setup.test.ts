/**
 * setup and createTelemetry on the server platform. setup installs globals, so each scenario runs in
 * a child process of the same runtime (test-support/setup-child.ts) against an in-process OTLP sink.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { O11yError } from "@libo11y/core";
import { type OtlpSink, startOtlpSink } from "@libo11y/test";
import { createTelemetry, setup } from "./setup.ts";
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
    // The export interval is the default minute, so only shutdown's final collection exports:
    // runtime metrics must still be running when it happens.
    const run = await runChild("triangle", { OTEL_EXPORTER_OTLP_ENDPOINT: sink.url });
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

// Third review: an option outside its closed set fails setup and createTelemetry with a typed
// error, where it used to be accepted in silence.
test("setup and createTelemetry reject an option value outside its closed set with INVALID_OPTION", async () => {
  const base = { serviceName: "options-test", environment: "test", hermetic: true } as const;
  for (const [options, message] of [
    [
      { logLevel: "verbose" },
      'o11y: invalid option logLevel: "verbose" (allowed: trace, debug, info, warn, error, fatal)',
    ],
    [{ console: "pretty" }, 'o11y: invalid option console: "pretty" (allowed: json, text, false)'],
    [{ piiMode: "bogus" }, 'o11y: invalid option piiMode: "bogus" (allowed: drop, hash, allow)'],
    [
      { exemplarFilter: "sometimes" },
      'o11y: invalid option exemplarFilter: "sometimes" (allowed: trace_based, always_on, always_off)',
    ],
    [{ runtimeMetrics: "false" }, 'o11y: invalid option runtimeMetrics: "false" (allowed: true, false)'],
  ] as const) {
    const refused = (err: unknown): boolean => {
      assert.ok(err instanceof O11yError, String(err));
      assert.equal(err.code, "INVALID_OPTION");
      assert.equal(err.message, message);
      return true;
    };
    await assert.rejects(createTelemetry({ ...base, ...options } as never), refused);
    await assert.rejects(setup({ ...base, ...options } as never), refused);
  }
  // Every refusal gave the setup guard back: a valid setup still works.
  const telemetry = await setup({ ...base, console: false, runtimeMetrics: false });
  await telemetry.shutdown();
});

// Fourth review, security: a key read from an environment variable is a string. It used to be
// accepted, and every token was then HMAC-SHA256 under the empty key. On this platform the HMAC is
// node:crypto's, which would take a string as a key, so the refusal has to come before it.
test("setup and createTelemetry reject a PII hash key that is a string and accept the bytes it decodes to", async () => {
  const base = {
    serviceName: "key-test",
    environment: "test",
    hermetic: true,
    console: false,
    runtimeMetrics: false,
  } as const;
  const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const refused = (err: unknown): boolean => {
    assert.ok(err instanceof O11yError, String(err));
    assert.equal(err.code, "PII_HASH_KEY");
    assert.equal(
      err.message,
      "o11y: piiHashKey must be bytes: pass a Uint8Array of at least 32 bytes, not a string (decode a hex or base64 secret into bytes first)",
    );
    return true;
  };
  for (const mode of [{ piiMode: "hash" }, { piiMode: "drop" }, { piiMode: "allow" }, {}]) {
    await assert.rejects(createTelemetry({ ...base, ...mode, piiHashKey: hex } as never), refused);
    await assert.rejects(setup({ ...base, ...mode, piiHashKey: hex } as never), refused);
  }

  const key = Buffer.from(hex, "hex");
  const want = (k: string | Uint8Array): string =>
    `hmac-sha256:${createHmac("sha256", k).update("10.1.2.3").digest("hex").slice(0, 32)}`;
  // Every refusal gave the setup guard back: setup with the decoded bytes works, and keys the token.
  const telemetry = await setup({
    ...base,
    piiMode: "hash",
    piiHashKey: key,
    resourceAttributes: { "host.ip": "10.1.2.3" },
  });
  try {
    assert.equal(telemetry.resource.attributes["host.ip"], want(key));
    assert.notEqual(telemetry.resource.attributes["host.ip"], want(""), "not the empty key's token");
  } finally {
    await telemetry.shutdown();
  }
});
