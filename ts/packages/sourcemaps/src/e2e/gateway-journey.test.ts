/**
 * The RUM gateway end-to-end journey: a real o11yrum-gateway binary, configured with a filesystem
 * object store and an OTLP sink, in front of the in-process OTLP sink from @libo11y/test. It sends
 * synthetic OTLP/JSON shaped like @libo11y/web output, uploads a Bun-built source map with
 * uploadSourceMaps, and checks what reaches the sink. It runs only when O11YRUM_GATEWAY_BIN names
 * the gateway binary (`make rum-e2e`), so `make ts-check` needs no Go toolchain.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type OtlpSink, startOtlpSink } from "@libo11y/test";
import { uploadSourceMaps } from "../upload.ts";

const BIN = process.env.O11YRUM_GATEWAY_BIN;
const journey = BIN === undefined || BIN === "" ? test.skip : test;
const ORIGIN = "https://shop.example";
const SERVICE = "shop-web";
const VERSION = "1.4.2";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let sink: OtlpSink | undefined;
let gateway: ChildProcess | undefined;
let dir: string | undefined;
let base = "";

before(async () => {
  if (BIN === undefined || BIN === "") return;
  sink = await startOtlpSink();
  dir = mkdtempSync(join(tmpdir(), "o11yrum-e2e-"));
  writeFileSync(join(dir, "token"), "upload-secret\n");
  writeFileSync(
    join(dir, "gateway.yaml"),
    [
      "listen: 127.0.0.1:0",
      "environment: test",
      "edge: {rate_limit_per_minute: 20}",
      "apps:",
      `  - service_name: ${SERVICE}`,
      `    origins: ["${ORIGIN}"]`,
      "    sourcemaps: {upload_token_file: token}",
      "object_store: {filesystem: {root: maps}}",
      `sinks: {otlp: {endpoint: "${sink.url}", compression: none}}`,
      "",
    ].join("\n"),
  );
  gateway = spawn(BIN, ["-config", join(dir, "gateway.yaml")], {
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_METRIC_EXPORT_INTERVAL: "300",
      OTEL_TRACES_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  base = await listeningAddress(gateway);
});

after(async () => {
  if (gateway !== undefined && gateway.exitCode === null) {
    const exited = new Promise<void>((resolve) => gateway?.once("exit", () => resolve()));
    gateway.kill("SIGTERM");
    await exited;
  }
  await sink?.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

journey("view summaries become derived metrics", async () => {
  const s = mustSink();
  const res = await postLogs(summaryLogs({ seq: 0, lcp: 1.8 }));
  assert.equal(res.status, 200, await res.text());
  await s.waitFor("logs", 1, 5000);
  const views = await waitForMetric(s, "o11y.rum.views", 10_000);
  assert.equal(pointAttr(views, "service.name"), SERVICE);
  const lcp = await waitForMetric(s, "o11y.rum.vital.lcp", 10_000);
  assert.equal(pointAttr(lcp, "o11y.rum.vital.rating"), "good");
});

journey("an uploaded source map symbolicates an error", async () => {
  const s = mustSink();
  const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
  const uploaded = await uploadSourceMaps({
    endpoint: base,
    token: "upload-secret",
    service: SERVICE,
    version: VERSION,
    urlPrefix: "/assets/",
    directory: fixtures,
  });
  assert.deepEqual(
    uploaded.map((u) => u.url),
    ["/assets/app.min.js"],
  );
  const js = readFileSync(join(fixtures, "app.min.js"), "utf8");
  const col = js.indexOf("throw") + 1;
  const seen = s.logs().length;
  const res = await postLogs(errorLogs(`Error: empty cart\n    at u (${ORIGIN}/assets/app.min.js:1:${col})`));
  assert.equal(res.status, 200, await res.text());
  await s.waitFor("logs", seen + 1, 5000);
  const record = lastRecord(s);
  assert.match(String(recordAttr(record, "exception.stacktrace")), /\(app\.ts:7:5\)/);
  assert.equal(String(recordAttr(record, "o11y.rum.error.fingerprint")).length, 32);
});

journey("an app without remote config answers 404", async () => {
  const res = await fetch(`${base}/_o11y/v1/config?service=${SERVICE}`);
  assert.equal(res.status, 404);
  await res.body?.cancel();
});

// Last: it spends the client's rate limit, which also covers the config endpoint.
journey("edge refusals", async () => {
  const evil = await postLogs(summaryLogs({ seq: 0 }), "https://evil.example");
  assert.equal(evil.status, 403);
  await evil.body?.cancel();
  let last = 200;
  let retryAfter: string | null = null;
  for (let i = 0; i < 25 && last !== 429; i++) {
    const res = await postLogs(summaryLogs({ seq: 1 }));
    last = res.status;
    retryAfter = res.headers.get("retry-after");
    await res.body?.cancel();
  }
  assert.equal(last, 429);
  assert.ok(Number(retryAfter) >= 1, `Retry-After ${retryAfter}`);
});

function mustSink(): OtlpSink {
  assert.ok(sink !== undefined, "the sink did not start");
  return sink;
}

// listeningAddress resolves the gateway's base URL from its "listening on" line, and rejects
// with what it wrote when it exits or stays silent for ten seconds.
function listeningAddress(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`the gateway did not start:\n${output}`)), 10_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const m = /o11yrum-gateway: listening on (\S+)/.exec(output);
      if (m !== null) {
        clearTimeout(timer);
        resolve(`http://${m[1]}`);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the gateway exited with ${code}:\n${output}`));
    });
  });
}

function postLogs(body: unknown, origin = ORIGIN): Promise<Response> {
  return fetch(`${base}/_o11y/v1/logs?sent_at=${Date.now()}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "user-agent": CHROME_UA },
    body: JSON.stringify(body),
  });
}

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number };

function kv(key: string, value: string | number | { int: number }): { key: string; value: AnyValue } {
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "number") return { key, value: { doubleValue: value } };
  return { key, value: { intValue: String(value.int) } };
}

// logsRequest wraps records the way @libo11y/web's OTLP/JSON exporter does.
function logsRequest(attributes: { key: string; value: AnyValue }[]): unknown {
  const now = `${Date.now()}000000`;
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            kv("service.name", SERVICE),
            kv("service.version", VERSION),
            kv("deployment.environment.name", "test"),
          ],
        },
        scopeLogs: [
          {
            scope: { name: "@libo11y/rum" },
            logRecords: [{ timeUnixNano: now, observedTimeUnixNano: now, attributes }],
          },
        ],
      },
    ],
  };
}

function summaryLogs(opts: { seq: number; lcp?: number }): unknown {
  const attrs = [
    kv("event.name", "o11y.rum.view.summary"),
    kv("o11y.rum.platform", "web"),
    kv("o11y.rum.view.id", "v-1"),
    kv("o11y.rum.view.name", "/cart"),
    kv("o11y.rum.view.kind", "initial"),
    kv("session.id", "s-1"),
    kv("o11y.rum.summary.seq", { int: opts.seq }),
    kv("o11y.rum.summary.time_on_view", 4.5),
  ];
  if (opts.lcp !== undefined) attrs.push(kv("o11y.rum.summary.lcp.value", opts.lcp));
  return logsRequest(attrs);
}

function errorLogs(stack: string): unknown {
  return logsRequest([
    kv("event.name", "o11y.rum.error"),
    kv("o11y.rum.platform", "web"),
    kv("o11y.rum.error.source", "uncaught"),
    kv("o11y.rum.view.id", "v-1"),
    kv("session.id", "s-1"),
    kv("exception.type", "Error"),
    kv("exception.message", "empty cart"),
    kv("exception.stacktrace", stack),
  ]);
}

interface KeyValue {
  readonly key?: string;
  readonly value?: Record<string, unknown>;
}

interface DataPoint {
  readonly attributes?: readonly KeyValue[];
}

interface MetricJSON {
  readonly name?: string;
  readonly sum?: { readonly dataPoints?: readonly DataPoint[] };
  readonly histogram?: { readonly dataPoints?: readonly DataPoint[] };
}

interface MetricsRequest {
  readonly resourceMetrics?: readonly {
    readonly scopeMetrics?: readonly { readonly metrics?: readonly MetricJSON[] }[];
  }[];
}

interface LogsRequest {
  readonly resourceLogs?: readonly {
    readonly scopeLogs?: readonly {
      readonly logRecords?: readonly { readonly attributes?: readonly KeyValue[] }[];
    }[];
  }[];
}

// waitForMetric polls the sink until a metric named name arrives with a data point, and returns
// the point.
async function waitForMetric(s: OtlpSink, name: string, timeoutMillis: number): Promise<DataPoint> {
  const deadline = Date.now() + timeoutMillis;
  for (;;) {
    for (const req of s.metrics() as readonly MetricsRequest[]) {
      for (const rm of req.resourceMetrics ?? []) {
        for (const sm of rm.scopeMetrics ?? []) {
          for (const m of sm.metrics ?? []) {
            const point = m.name === name ? (m.sum ?? m.histogram)?.dataPoints?.[0] : undefined;
            if (point !== undefined) return point;
          }
        }
      }
    }
    if (Date.now() > deadline) throw new Error(`no ${name} metric within ${timeoutMillis} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function attrValue(attrs: readonly KeyValue[] | undefined, key: string): unknown {
  const v = attrs?.find((a) => a.key === key)?.value;
  return v === undefined ? undefined : Object.values(v)[0];
}

function pointAttr(point: DataPoint, key: string): unknown {
  return attrValue(point.attributes, key);
}

function lastRecord(s: OtlpSink): { readonly attributes?: readonly KeyValue[] } {
  const reqs = s.logs() as readonly LogsRequest[];
  const record = reqs.at(-1)?.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0];
  assert.ok(record !== undefined, "the sink holds no log record");
  return record;
}

function recordAttr(record: { readonly attributes?: readonly KeyValue[] }, key: string): unknown {
  return attrValue(record.attributes, key);
}
