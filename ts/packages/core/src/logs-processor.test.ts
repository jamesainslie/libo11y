import assert from "node:assert/strict";
import { test } from "node:test";
import { context, logs, ROOT_CONTEXT } from "@opentelemetry/api";
import {
  BatchLogRecordProcessor,
  InMemoryLogRecordExporter,
  LoggerProvider,
  type LogRecordProcessor,
  type ReadWriteLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { isClassified, markClassified, RedactingLogRecordProcessor } from "./logs-processor.ts";
import { SensitivityPolicy, type ViolationSink } from "./policy.ts";

// The probe: sdk-logs 3.1.1 has no API to remove an attribute, so redaction deletes the key from
// record.attributes inside onEmit. This proves the export then lacks it, with simple and batch
// processors after the deleting one, and that setAttribute replaces a value in place.
test("probe: a key deleted from record.attributes in onEmit is absent from the export", async () => {
  const deleting: LogRecordProcessor = {
    onEmit(record: ReadWriteLogRecord) {
      delete (record.attributes as Record<string, unknown>).secret;
      record.setAttribute("pii", "token");
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const simple = new InMemoryLogRecordExporter();
  const batched = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [
      deleting,
      new SimpleLogRecordProcessor({ exporter: simple }),
      new BatchLogRecordProcessor({ exporter: batched }),
    ],
  });
  provider.getLogger("probe").emit({ body: "b", attributes: { secret: "s", pii: "raw", kept: 1 } });
  await provider.forceFlush();
  for (const exporter of [simple, batched]) {
    const [record] = exporter.getFinishedLogRecords();
    assert.ok(record);
    assert.deepEqual(record.attributes, { pii: "token", kept: 1 });
    assert.equal(Object.hasOwn(record.attributes, "secret"), false);
  }
  await provider.shutdown();
});

class Counts implements ViolationSink {
  readonly seen: string[] = [];
  add(signal: string, rule: string, n: number): void {
    for (let i = 0; i < n; i++) this.seen.push(`${signal}/${rule}`);
  }
}

const KEY = new Uint8Array(32).fill(5);

function pipeline(policy: SensitivityPolicy) {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new RedactingLogRecordProcessor(policy), new SimpleLogRecordProcessor({ exporter })],
  });
  return { exporter, provider };
}

test("a bridge record through the global logs API is classified and counted once", async () => {
  const counts = new Counts();
  const policy = SensitivityPolicy.create({ pii: "hash", key: KEY, registries: [] }).withRecorder(counts);
  const { exporter, provider } = pipeline(policy);
  logs.setGlobalLoggerProvider(provider);
  try {
    logs.getLogger("bridge").emit({
      body: "hello",
      attributes: { "http.request.header.authorization": "Bearer x", "host.ip": "10.0.0.1", ok: true },
    });
  } finally {
    logs.disable();
  }
  await provider.forceFlush();
  const [record] = exporter.getFinishedLogRecords();
  assert.ok(record);
  assert.deepEqual(record.attributes, { "host.ip": policy.tokenOf("10.0.0.1"), ok: true });
  assert.equal(record.body, "hello");
  assert.deepEqual(counts.seen.sort(), ["logs/pii_attribute", "logs/secret_attribute"]);
  await provider.shutdown();
});

test("map values are walked on dotted keys and emptied maps dropped", async () => {
  const policy = SensitivityPolicy.create({ pii: "drop", registries: [] });
  const { exporter, provider } = pipeline(policy);
  provider.getLogger("bridge").emit({
    attributes: { host: { ip: "1", name: "h" }, http: { request: { header: { cookie: "c" } } }, n: 1 },
  });
  await provider.forceFlush();
  assert.deepEqual(exporter.getFinishedLogRecords()[0]?.attributes, { host: { name: "h" }, n: 1 });
  await provider.shutdown();
});

test("a record the libo11y logger already classified is left alone and not counted", async () => {
  const counts = new Counts();
  const policy = SensitivityPolicy.create({ pii: "drop", registries: [] }).withRecorder(counts);
  const { exporter, provider } = pipeline(policy);
  const ctx = markClassified(ROOT_CONTEXT);
  assert.equal(isClassified(ctx), true);
  assert.equal(isClassified(ROOT_CONTEXT), false);
  provider.getLogger("core").emit({ attributes: { "host.ip": "1" }, context: ctx });
  await provider.forceFlush();
  assert.deepEqual(exporter.getFinishedLogRecords()[0]?.attributes, { "host.ip": "1" });
  assert.deepEqual(counts.seen, []);
  await provider.shutdown();
});

test("the active context's mark is honoured when the record carries none", async () => {
  const policy = SensitivityPolicy.create({ pii: "drop", registries: [] });
  const { exporter, provider } = pipeline(policy);
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks");
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  try {
    context.with(markClassified(ROOT_CONTEXT), () => {
      provider.getLogger("core").emit({ attributes: { "host.ip": "1" } });
    });
  } finally {
    context.disable();
  }
  await provider.forceFlush();
  assert.deepEqual(exporter.getFinishedLogRecords()[0]?.attributes, { "host.ip": "1" });
  await provider.shutdown();
});

test("a record with nothing classified is untouched", async () => {
  const policy = SensitivityPolicy.create({ pii: "drop", registries: [] });
  let before: unknown;
  let after: unknown;
  const spy: LogRecordProcessor = {
    onEmit(r) {
      after = r.attributes;
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const first: LogRecordProcessor = {
    onEmit(r) {
      before = r.attributes;
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const provider = new LoggerProvider({ processors: [first, new RedactingLogRecordProcessor(policy), spy] });
  provider.getLogger("x").emit({ attributes: { a: 1, nested: { b: [1, 2] } } });
  assert.equal(after, before);
  assert.deepEqual(after, { a: 1, nested: { b: [1, 2] } });
  await provider.shutdown();
});

test("forceFlush and shutdown resolve", async () => {
  const p = new RedactingLogRecordProcessor(SensitivityPolicy.create({ pii: "drop", registries: [] }));
  await p.forceFlush();
  await p.shutdown();
});
