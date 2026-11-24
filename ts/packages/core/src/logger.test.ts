import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { context, ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { ConsoleSink } from "./console-sink.ts";
import type { LogLevel } from "./log-values.ts";
import { CoreLogger, forceEmit, isForced, LogPipeline, SEVERITY_NUMBER } from "./logger.ts";
import { RedactingLogRecordProcessor } from "./logs-processor.ts";
import type { AttrReplacer } from "./options.ts";
import { SensitivityPolicy, type ViolationSink } from "./policy.ts";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";
const TIME = new Date(Date.UTC(2026, 10, 24, 1, 2, 3, 400));
const KEY = new Uint8Array(32).fill(9);

class Counts implements ViolationSink {
  readonly seen: string[] = [];
  add(signal: string, rule: string, n: number): void {
    for (let i = 0; i < n; i++) this.seen.push(`${signal}/${rule}`);
  }
}

function harness(
  opts: {
    level?: LogLevel;
    replacer?: AttrReplacer;
    pii?: "drop" | "hash";
    write?: (l: string) => void;
  } = {},
) {
  const counts = new Counts();
  const policy = SensitivityPolicy.create({ pii: opts.pii ?? "drop", key: KEY, registries: [] }).withRecorder(
    counts,
  );
  const lines: string[] = [];
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new RedactingLogRecordProcessor(policy), new SimpleLogRecordProcessor({ exporter })],
  });
  const pipeline = new LogPipeline({
    level: opts.level ?? "info",
    policy,
    console: new ConsoleSink("json", opts.write ?? ((l) => lines.push(l))),
    otlp: provider.getLogger("@libo11y/core"),
    now: () => TIME,
    ...(opts.replacer === undefined ? {} : { replacer: opts.replacer }),
  });
  return { logger: new CoreLogger(pipeline), pipeline, lines, exporter, provider, counts, policy };
}

function inSpan<T>(fn: () => T): T {
  const ctx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
  });
  return context.with(ctx, fn);
}

function withContextManager(fn: () => Promise<void> | void) {
  return async () => {
    const cm = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(cm);
    try {
      await fn();
    } finally {
      context.disable();
    }
  };
}

test(
  "a log inside a span carries its IDs on the console line and the OTLP record",
  withContextManager(() => {
    const { logger, lines, exporter } = harness();
    inSpan(() => logger.info("hello", { route: "/a", n: 2 }));
    assert.deepEqual(lines, [
      `{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"hello","trace_id":"${TRACE_ID}","span_id":"${SPAN_ID}","route":"/a","n":2}`,
    ]);
    const [record] = exporter.getFinishedLogRecords();
    assert.ok(record);
    assert.equal(record.body, "hello");
    assert.equal(record.severityNumber, 9);
    assert.equal(record.severityText, "INFO");
    assert.equal(record.spanContext?.traceId, TRACE_ID);
    assert.equal(record.spanContext?.spanId, SPAN_ID);
    assert.deepEqual(record.attributes, { route: "/a", n: 2 });
    assert.equal(record.instrumentationScope.name, "@libo11y/core");
  }),
);

test("severity numbers and texts are Go's", async () => {
  const { logger, lines, exporter } = harness({ level: "trace" });
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) logger[level](level);
  assert.deepEqual(
    exporter.getFinishedLogRecords().map((r) => [r.severityNumber, r.severityText]),
    [
      [1, "TRACE"],
      [5, "DEBUG"],
      [9, "INFO"],
      [13, "WARN"],
      [17, "ERROR"],
      [21, "FATAL"],
    ],
  );
  assert.deepEqual(SEVERITY_NUMBER, { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 });
  assert.equal(lines.length, 6);
});

test(
  "records below the level are gated unless forced, and forcing changes nothing else",
  withContextManager(() => {
    const { logger, lines } = harness({ level: "warn" });
    logger.info("dropped");
    logger.debug("dropped too", { "event.name": "x" });
    context.with(forceEmit(), () => logger.debug("forced"));
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /"level":"DEBUG","msg":"forced"/);
    assert.equal(isForced(forceEmit(ROOT_CONTEXT)), true);
    assert.equal(isForced(ROOT_CONTEXT), false);
  }),
);

test("an Error argument expands to exception.* and nested errors render as strings", () => {
  const { logger, exporter, lines } = harness();
  const err = new RangeError("out of range");
  logger.error("failed", err);
  const [r1] = exporter.getFinishedLogRecords();
  assert.equal(r1?.attributes["exception.type"], "RangeError");
  assert.equal(r1?.attributes["exception.message"], "out of range");
  assert.equal(r1?.attributes["exception.stacktrace"], err.stack);

  logger.warn("first error expands", {
    a: 1,
    cause: new TypeError("t"),
    other: new Error("o"),
    g: { e: new Error("n") },
  });
  const r2 = exporter.getFinishedLogRecords()[1];
  assert.deepEqual(Object.keys(r2?.attributes ?? {}), [
    "a",
    "exception.type",
    "exception.message",
    "exception.stacktrace",
    "other",
    "g",
  ]);
  assert.equal(r2?.attributes.other, "Error: o");
  assert.deepEqual(r2?.attributes.g, { e: "Error: n" });
  assert.match(lines[1] ?? "", /"other":"Error: o","g":\{"e":"Error: n"\}/);
});

test("user trace_id and span_id at the top level are dropped, nested ones kept", () => {
  const { logger, lines } = harness();
  logger.info("m", { trace_id: "fake", span_id: "fake", g: { trace_id: "kept" } });
  assert.equal(
    lines[0],
    '{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"m","g":{"trace_id":"kept"}}',
  );
});

test("groups nest on the console and become maps on OTLP", () => {
  const { logger, lines, exporter } = harness();
  logger.info("m", { http: { method: "GET", status: 200 }, big: 10n, bytes: Uint8Array.of(255) });
  assert.equal(
    lines[0],
    '{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"m","http":{"method":"GET","status":200},"big":"10","bytes":"/w=="}',
  );
  const [r] = exporter.getFinishedLogRecords();
  assert.deepEqual(r?.attributes, {
    http: { method: "GET", status: 200 },
    big: "10",
    bytes: Uint8Array.of(255),
  });
});

test("the replacer runs once per leaf with the group path, before the policy", () => {
  const seen: string[] = [];
  const replacer: AttrReplacer = (key, value, groups) => {
    seen.push([...groups, key].join("."));
    if (key === "rename") return ["http.request.header.authorization", value];
    if (key === "drop") return undefined;
    return [key, value];
  };
  const { logger, lines, exporter, counts } = harness({ replacer });
  logger.info("m", { rename: "Bearer x", drop: 1, g: { k: "v" }, kept: true });
  assert.deepEqual(seen, ["rename", "drop", "g.k", "kept"]);
  assert.equal(
    lines[0],
    '{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"m","g":{"k":"v"},"kept":true}',
  );
  assert.deepEqual(exporter.getFinishedLogRecords()[0]?.attributes, { g: { k: "v" }, kept: true });
  // One drop per sink.
  assert.deepEqual(counts.seen, ["logs/secret_attribute", "logs/secret_attribute"]);
});

test("PII is tokenized once per sink, and the bridge processor does not hash the token again", () => {
  const { logger, lines, exporter, policy } = harness({ pii: "hash" });
  logger.info("m", { "host.ip": "10.0.0.1" });
  const token = policy.tokenOf("10.0.0.1");
  assert.equal(lines[0], `{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"m","host.ip":"${token}"}`);
  assert.equal(exporter.getFinishedLogRecords()[0]?.attributes["host.ip"], token);
});

test("child loggers prepend their attributes and children compose", () => {
  const { logger, lines } = harness();
  const child = logger.child({ svc: "a", shared: 1 }).child({ req: "r1" });
  child.info("m", { shared: 2 });
  assert.equal(
    lines[0],
    '{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"m","svc":"a","shared":2,"req":"r1"}',
  );
});

test("a failing console write is swallowed, and emitStrict rethrows it", () => {
  const { logger, pipeline, exporter } = harness({
    write: () => {
      throw new Error("EPIPE");
    },
  });
  logger.info("still exported");
  assert.equal(exporter.getFinishedLogRecords().length, 1);
  assert.throws(() => pipeline.emit("info", "canary", {}, { strict: true }), /EPIPE/);
});

test("a console-only emit skips the OTLP leg", () => {
  const { pipeline, lines, exporter } = harness();
  pipeline.emit("info", "dropped", { a: 1 }, { consoleOnly: true });
  assert.equal(lines.length, 1);
  assert.equal(exporter.getFinishedLogRecords().length, 0);
});

test("fatal logs at FATAL and returns", () => {
  const { logger, lines } = harness();
  logger.fatal("bye", { code: 1 });
  assert.match(lines[0] ?? "", /"level":"FATAL","msg":"bye","code":1/);
});

// Review C1: an empty-keyed group is inlined, so its members are judged on the parent's path. Before
// the fix it was inlined only by the replacer walk, and the policy joined an empty path segment,
// so a secret under "" reached both sinks.
for (const withReplacer of [false, true]) {
  test(`empty-keyed groups cannot hide a secret or PII from either sink (replacer: ${withReplacer})`, () => {
    const { logger, lines, exporter } = harness(withReplacer ? { replacer: (k, v) => [k, v] } : {});
    logger.info("top", {
      "": { "http.request.header.authorization": "Bearer SECRET", "host.ip": "1.2.3.4", ok: 1 },
    } as never);
    logger.info("nested", {
      http: { "": { "request.header.authorization": "Bearer SECRET2" }, ok: 2 },
    } as never);
    logger.info("deep", { host: { "": { "": { ip: "5.6.7.8" } } }, b: { "": {} } } as never);
    const all = `${lines.join("\n")}\n${JSON.stringify(exporter.getFinishedLogRecords().map((r) => r.attributes))}`;
    for (const leaked of ["SECRET", "1.2.3.4", "5.6.7.8"])
      assert.ok(!all.includes(leaked), `${leaked} leaked:\n${all}`);
    assert.equal(lines[0], '{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"top","ok":1}');
    assert.equal(lines[1], '{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"nested","http":{"ok":2}}');
    assert.equal(lines[2], '{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"deep"}');
    const records = exporter.getFinishedLogRecords();
    assert.deepEqual(records[0]?.attributes, { ok: 1 });
    assert.deepEqual(records[1]?.attributes, { http: { ok: 2 } });
    assert.deepEqual(records[2]?.attributes, {});
  });
}

test("a replacer that returns a group under a classified path is still classified", () => {
  const { logger, lines } = harness({
    replacer: (k, v) => (k === "a" ? ["http", { request: { header: { authorization: v } } }] : [k, v]),
  });
  logger.info("m", { a: "SECRET4" });
  assert.equal(lines[0], '{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"m"}');
});

test("an Error from another realm expands like a local one", () => {
  const { logger, exporter, lines } = harness();
  const foreign = runInNewContext("new TypeError('elsewhere')") as Error;
  logger.error("failed", foreign);
  logger.warn("attr", { cause: runInNewContext("new RangeError('r')") as Error });
  const [r1, r2] = exporter.getFinishedLogRecords();
  assert.equal(r1?.attributes["exception.type"], "TypeError");
  assert.equal(r1?.attributes["exception.message"], "elsewhere");
  assert.equal(r2?.attributes["exception.type"], "RangeError");
  assert.match(lines[0] ?? "", /"exception.type":"TypeError"/);
});

test("groups inside arrays are judged on the holder's path", () => {
  const { logger, lines, exporter } = harness();
  logger.info("a", { http: [{ request: { header: { authorization: "S3" } } }] } as never);
  logger.info("b", { host: [[{ ip: "1.1.1.1" }]] } as never);
  const all = `${lines.join("\n")}\n${JSON.stringify(exporter.getFinishedLogRecords().map((r) => r.attributes))}`;
  for (const leaked of ["S3", "1.1.1.1"]) assert.ok(!all.includes(leaked), `${leaked} leaked:\n${all}`);
});
