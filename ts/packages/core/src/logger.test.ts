import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { CompiledAppRegistry } from "@libo11y/spec";
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
    registries?: readonly CompiledAppRegistry[];
    write?: (l: string) => void;
  } = {},
) {
  const counts = new Counts();
  const policy = SensitivityPolicy.create({
    pii: opts.pii ?? "drop",
    key: KEY,
    registries: opts.registries ?? [],
  }).withRecorder(counts);
  const lines: string[] = [];
  const errors: unknown[] = [];
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
    onError: (err) => errors.push(err),
    ...(opts.replacer === undefined ? {} : { replacer: opts.replacer }),
  });
  return { logger: new CoreLogger(pipeline), pipeline, lines, errors, exporter, provider, counts, policy };
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

// An Error under a key the policy drops or tokenizes must not escape through exception.*: its own
// key was discarded before the policy ran, so the message and stack went out in clear text.
test("an Error under a secret key is dropped whole from both sinks", () => {
  const { logger, lines, exporter, counts } = harness();
  logger.info("x", { "http.request.header.authorization": new Error("Bearer abc"), ok: 1 });
  assert.equal(lines[0], '{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"x","ok":1}');
  assert.deepEqual(exporter.getFinishedLogRecords()[0]?.attributes, { ok: 1 });
  assert.doesNotMatch(lines[0] ?? "", /Bearer|exception/);
  // Counted once per sink, as a string value is.
  assert.deepEqual(counts.seen, ["logs/secret_attribute", "logs/secret_attribute"]);
});

test("an Error under a PII key is dropped in drop mode, counted once per sink as a string is", () => {
  const withError = harness();
  withError.logger.info("x", { "host.ip": new Error("10.0.0.1") });
  const withString = harness();
  withString.logger.info("x", { "host.ip": "10.0.0.1" });
  assert.equal(withError.lines[0], '{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"x"}');
  assert.deepEqual(withError.exporter.getFinishedLogRecords()[0]?.attributes, {});
  assert.deepEqual(withError.counts.seen, ["logs/pii_attribute", "logs/pii_attribute"]);
  assert.deepEqual(withError.counts.seen, withString.counts.seen);
});

test("an Error under a PII key is tokenized in hash mode, as the string a second Error renders to", () => {
  const { logger, lines, exporter, policy, counts } = harness({ pii: "hash" });
  const err = new Error("10.0.0.1");
  logger.info("x", { "host.ip": err });
  const token = policy.tokenOf(String(err));
  assert.equal(lines[0], `{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"x","host.ip":"${token}"}`);
  assert.deepEqual(exporter.getFinishedLogRecords()[0]?.attributes, { "host.ip": token });
  assert.deepEqual(counts.seen, ["logs/pii_attribute", "logs/pii_attribute"]);
});

test("an Error under a key an application registry classifies secret is dropped from both sinks", () => {
  const registry: CompiledAppRegistry = { namespace: "lor", classes: { "lor.session.token": "secret" } };
  const { logger, lines, exporter } = harness({ registries: [registry] });
  logger.info("x", { "lor.session.token": new Error("tok-123") });
  assert.equal(lines[0], '{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"x"}');
  assert.deepEqual(exporter.getFinishedLogRecords()[0]?.attributes, {});
});

test("an Error under an unclassified key still expands, after one under a dropped key", () => {
  const { logger, exporter, lines } = harness();
  const err = new TypeError("boom");
  logger.info("x", { "http.request.header.authorization": new Error("Bearer abc"), cause: err });
  assert.deepEqual(exporter.getFinishedLogRecords()[0]?.attributes, {
    "exception.type": "TypeError",
    "exception.message": "boom",
    "exception.stacktrace": err.stack,
  });
  assert.doesNotMatch(lines[0] ?? "", /Bearer/);
});

test("a replacer cannot add a top-level trace_id or span_id on either sink", () => {
  const replacer: AttrReplacer = (key, value) => {
    if (key === "t") return ["trace_id", value];
    if (key === "s") return ["span_id", value];
    return [key, value];
  };
  const outside = harness({ replacer });
  outside.logger.info("m", { t: "fake", s: "fake", ok: 1 });
  assert.equal(outside.lines[0], '{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"m","ok":1}');
  assert.deepEqual(outside.exporter.getFinishedLogRecords()[0]?.attributes, { ok: 1 });

  const inside = harness({ replacer });
  const ctx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
  });
  inside.pipeline.emit("info", "m", { t: "fake", s: "fake", g: { t: "kept" } }, { ctx });
  assert.equal(inside.lines.length, 1);
  // The top-level keys follow a comma; the nested one opens its group.
  assert.equal(inside.lines[0]?.match(/,"trace_id"/g)?.length, 1, inside.lines[0]);
  assert.equal(inside.lines[0]?.match(/,"span_id"/g)?.length, 1, inside.lines[0]);
  assert.match(inside.lines[0] ?? "", new RegExp(`"trace_id":"${TRACE_ID}","span_id":"${SPAN_ID}"`));
  assert.match(inside.lines[0] ?? "", /"g":\{"trace_id":"kept"\}/);
  for (const r of inside.exporter.getFinishedLogRecords()) {
    assert.equal(r.attributes.trace_id, undefined);
    assert.equal(r.attributes.span_id, undefined);
  }
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

// Site review: telemetry-side input and user hooks must never throw into the host. Each failure is
// reported to the pipeline's error handler, and the pipeline fails closed.
const PREFIX = '{"time":"2026-11-24T01:02:03.4Z","level":"INFO","msg":"m"';

function messages(errors: readonly unknown[]): string[] {
  return errors.map((e) => (e instanceof Error ? e.message : String(e)));
}

function revoked(): never {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy as never;
}

test("a replacer that throws drops the record from every sink and is reported, never thrown", () => {
  const { logger, lines, errors, exporter } = harness({
    replacer: () => {
      throw new Error("replacer boom");
    },
  });
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
    assert.doesNotThrow(() => logger[level]("m", { a: 1 }));
  }
  assert.doesNotThrow(() => logger.error("m", new Error("e")));
  assert.deepEqual(lines, [], "nothing unredacted reaches the console");
  assert.equal(exporter.getFinishedLogRecords().length, 0, "nothing unredacted reaches OTLP");
  assert.equal(errors.length, 5, "one report per record at or above the level");
  assert.match(
    messages(errors)[0] ?? "",
    /^o11y: attrReplacer failed on "a", the INFO record is dropped: Error$/,
  );
});

test("a replacer that returns something unusable drops the record", () => {
  const { logger, lines, errors } = harness({ replacer: () => null as never });
  assert.doesNotThrow(() => logger.info("m", { a: 1 }));
  assert.deepEqual(lines, []);
  assert.equal(errors.length, 1);
  assert.equal(
    messages(errors)[0],
    'o11y: attrReplacer failed on "a", the INFO record is dropped: TypeError',
  );
});

test("an attribute whose getter throws is dropped and reported, and the rest of the record is kept", () => {
  const { logger, lines, errors, exporter } = harness();
  const attrs = {
    before: 1,
    get bad(): string {
      throw new Error("getter boom");
    },
    g: {
      get inner(): string {
        throw new Error("inner boom");
      },
      k: "v",
    },
    after: 2,
  };
  assert.doesNotThrow(() => logger.info("m", attrs));
  assert.deepEqual(lines, [`${PREFIX},"before":1,"g":{"k":"v"},"after":2}`]);
  assert.deepEqual(exporter.getFinishedLogRecords()[0]?.attributes, { before: 1, g: { k: "v" }, after: 2 });
  assert.deepEqual(messages(errors), [
    'o11y: log attribute "bad" cannot be read and is dropped: Error',
    'o11y: log attribute "g.inner" cannot be read and is dropped: Error',
  ]);
});

test("attributes that are a revoked proxy are dropped and the record is still emitted", () => {
  const { logger, lines, errors } = harness();
  assert.doesNotThrow(() => logger.info("m", revoked()));
  assert.deepEqual(lines, [`${PREFIX}}`]);
  assert.equal(errors.length, 1);
  assert.equal(messages(errors)[0], "o11y: log attributes cannot be read and are dropped: TypeError");
});

test("a value that cannot be classified is dropped where it sits: top level, in a group, in an array", () => {
  const { logger, lines, errors, exporter } = harness();
  assert.doesNotThrow(() =>
    logger.info("m", {
      a: 1,
      nested: revoked(),
      g: { inner: revoked(), k: "v" },
      list: [1, revoked()],
      deep: [{ ok: true }, [{ bad: revoked() }]],
      z: 2,
    }),
  );
  assert.deepEqual(lines, [`${PREFIX},"a":1,"g":{"k":"v"},"z":2}`]);
  assert.deepEqual(exporter.getFinishedLogRecords()[0]?.attributes, { a: 1, g: { k: "v" }, z: 2 });
  assert.equal(errors.length, 4);
  for (const [i, key] of ["nested", "g.inner", "list", "deep"].entries()) {
    assert.equal(
      messages(errors)[i],
      `o11y: log attribute "${key}" cannot be read and is dropped: TypeError`,
    );
  }
});

test("values inside arrays are read once, so a getter cannot change between the policy and the sink", () => {
  const { logger, lines, errors } = harness();
  let reads = 0;
  const member = {
    get n(): number {
      reads++;
      return reads;
    },
  };
  logger.info("m", { list: [member] } as never);
  assert.equal(reads, 1);
  assert.deepEqual(lines, [`${PREFIX},"list":[{"n":1}]}`]);
  assert.deepEqual(errors, []);
});

test("arrays keep cycles and shared members as the policy expects them", () => {
  const { logger, lines, errors } = harness();
  const shared = { s: 1 };
  const cyclic: unknown[] = [shared, shared];
  cyclic.push(cyclic);
  assert.doesNotThrow(() => logger.info("m", { list: cyclic } as never));
  assert.deepEqual(lines, [`${PREFIX},"list":[{"s":1},{"s":1}]}`]);
  assert.deepEqual(errors, []);
});

test("child never throws: unreadable bindings are dropped and reported, the rest are kept", () => {
  const { logger, lines, errors } = harness();
  let child = logger;
  assert.doesNotThrow(() => {
    child = logger.child(revoked()) as CoreLogger;
  });
  assert.doesNotThrow(() => {
    child = child.child({
      svc: "a",
      get bad(): string {
        throw new Error("getter boom");
      },
    }) as CoreLogger;
  });
  child.info("m", { k: 1 });
  assert.deepEqual(lines, [`${PREFIX},"svc":"a","k":1}`]);
  assert.equal(errors.length, 2);
  assert.equal(messages(errors)[0], "o11y: log attributes cannot be read and are dropped: TypeError");
  assert.equal(messages(errors)[1], 'o11y: log attribute "bad" cannot be read and is dropped: Error');
});

test("an Error argument that cannot be read costs its exception attributes, not the record", () => {
  const { logger, lines, errors } = harness();
  const err = new Error("e");
  Object.defineProperty(err, "message", {
    get() {
      throw new Error("message boom");
    },
  });
  assert.doesNotThrow(() => logger.error("m", err));
  assert.doesNotThrow(() => logger.fatal("m", revoked()));
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /"level":"ERROR","msg":"m"\}$/);
  assert.match(lines[1] ?? "", /"level":"FATAL","msg":"m"\}$/);
  assert.equal(errors.length, 2);
});

test("a sink that throws is reported, and the other sink still gets the record", () => {
  const { logger, errors, exporter } = harness({
    write: () => {
      throw new Error("EPIPE");
    },
  });
  assert.doesNotThrow(() => logger.info("m"));
  assert.equal(exporter.getFinishedLogRecords().length, 1);
  assert.deepEqual(messages(errors), ["o11y: writing a log record to the console failed: Error"]);
});

test("an error handler that throws is itself contained", () => {
  const policy = SensitivityPolicy.create({ pii: "drop", registries: [] });
  const pipeline = new LogPipeline({
    level: "info",
    policy,
    replacer: () => {
      throw new Error("replacer boom");
    },
    onError: () => {
      throw new Error("handler boom");
    },
  });
  assert.doesNotThrow(() => new CoreLogger(pipeline).info("m", { a: 1 }));
});

test("the strict path still throws what a replacer throws, for the startup canary", () => {
  const { pipeline, lines } = harness({
    replacer: () => {
      throw new Error("replacer boom");
    },
  });
  assert.throws(() => pipeline.emit("info", "canary", { a: 1 }, { strict: true }), /replacer boom/);
  assert.deepEqual(lines, []);
});

// Second review, W2. An error's message can carry the value that made it fail: new URL(value) and
// JSON.parse(value) both quote their input. So a report names the step, the class of the error and
// the attribute key, and never the message. The error itself stays on cause.
const MARKER = "sk_live_MARKER_9f8e7d";

test("no report carries the message of what was thrown, only its class, and the cause keeps the error", () => {
  const thrown = new RangeError(`cannot parse ${MARKER}`);
  const replacing = harness({
    replacer: () => {
      throw thrown;
    },
  });
  replacing.logger.fatal("webhook rejected", { payload: MARKER });
  const reading = harness();
  reading.logger.info("lookup", {
    get user(): string {
      throw new SyntaxError(`no row for ${MARKER}`);
    },
    list: [
      {
        get inner(): string {
          throw new Error(MARKER);
        },
      },
    ],
  } as never);
  const writing = harness({
    write: () => {
      throw Object.assign(new Error(`write failed near ${MARKER}`), { code: "EPIPE" });
    },
  });
  writing.logger.info("m");

  assert.deepEqual(messages(replacing.errors), [
    'o11y: attrReplacer failed on "payload", the FATAL record is dropped: RangeError',
  ]);
  assert.deepEqual(messages(reading.errors), [
    'o11y: log attribute "user" cannot be read and is dropped: SyntaxError',
    'o11y: log attribute "list" cannot be read and is dropped: Error',
  ]);
  assert.deepEqual(messages(writing.errors), ["o11y: writing a log record to the console failed: Error"]);
  for (const err of [...replacing.errors, ...reading.errors, ...writing.errors]) {
    assert.ok(!String((err as Error).message).includes("MARKER"), (err as Error).message);
    assert.ok(!String((err as Error).stack).includes("MARKER"), "the stack repeats the message");
  }
  assert.equal((replacing.errors[0] as Error).cause, thrown, "the cause keeps the original error");
  assert.deepEqual(replacing.lines, [], "the record is still dropped whole");
});

test("a thrown value that is not an Error is reported by its type, and a made-up class name is not trusted", () => {
  const { logger, errors } = harness();
  class Odd extends Error {}
  Object.defineProperty(Odd, "name", { value: `leak ${MARKER}` });
  logger.info("m", {
    get a(): string {
      throw MARKER;
    },
    get b(): string {
      throw null;
    },
    get c(): string {
      throw new Odd(MARKER);
    },
    get d(): string {
      throw Object.assign(new Error("x"), { code: `not a code ${MARKER}` });
    },
  });
  assert.deepEqual(messages(errors), [
    'o11y: log attribute "a" cannot be read and is dropped: string',
    'o11y: log attribute "b" cannot be read and is dropped: null',
    'o11y: log attribute "c" cannot be read and is dropped: Error',
    'o11y: log attribute "d" cannot be read and is dropped: Error',
  ]);
});
