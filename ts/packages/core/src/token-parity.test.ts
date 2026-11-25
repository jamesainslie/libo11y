/**
 * One canonical rendering for PII tokens on every signal. The specification computes a token "over
 * one canonical rendering of the value shared by every signal", so the token for a value must not
 * depend on where the value travels: a log record, a span, span event or span link attribute, or
 * the resource.
 *
 * Third review: the attribute path rendered without bounds where the log path stops at 2048 nodes,
 * so an array of more than 2047 elements got one token on a log record and another on a span. Go
 * had the same split and now bounds the attribute path the same way.
 *
 * The conformance vectors are Go's output. Every vector is run here through each token path, so a
 * case Go adds to the file proves each path without a change to this test.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { renderCanonical, TRUNCATED, WALK_BUDGET } from "./canonical.ts";
import { buildResource } from "./identity.ts";
import { SensitivityPolicy } from "./policy.ts";
import { createTelemetryWith } from "./telemetry.ts";
import { createTestPlatform } from "./testing.ts";

interface PiiCase {
  readonly name: string;
  readonly kind: string;
  readonly value: unknown;
  readonly canonical: string;
  readonly token: string;
}

const vectors = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "..", "..", "..", "..", "conformance", "vectors", "pii-hash.json"),
    "utf8",
  ),
) as { key_hex: string; cases: PiiCase[] };
const KEY = Uint8Array.from(Buffer.from(vectors.key_hex, "hex"));

/** A PII key in the specification's table, so hash mode rewrites its value to a token. */
const PII_KEY = "host.ip";

function policy(): SensitivityPolicy {
  return SensitivityPolicy.create({ pii: "hash", key: KEY, registries: [] });
}

// A vector's JSON value as a caller would hold it: bytes arrive as base64.
function input(c: PiiCase): unknown {
  return c.kind === "bytes" ? new Uint8Array(Buffer.from(c.value as string, "base64")) : c.value;
}

/** The kinds an OpenTelemetry attribute can hold. A map is a log value, and is checked as one too. */
const ATTRIBUTE_KINDS = [
  "string",
  "int",
  "float",
  "bool",
  "string_array",
  "int_array",
  "float_array",
  "bool_array",
  "bytes",
] as const;

test("the vectors hold every kind an attribute can carry", () => {
  const kinds = new Set(vectors.cases.map((c) => c.kind));
  for (const kind of [...ATTRIBUTE_KINDS, "map"]) assert.ok(kinds.has(kind), kind);
});

for (const c of vectors.cases) {
  test(`${c.kind} "${c.name}": the span attribute path gives the vector's token`, () => {
    // The policy's attribute rewrite is what a span's, a span event's and a span link's attributes
    // go through (spans.ts), and what a record from another log bridge does not.
    const out = policy().attributes("traces", { [PII_KEY]: input(c) as never });
    assert.equal(out[PII_KEY], c.token);
  });

  test(`${c.kind} "${c.name}": the log path gives the vector's token`, () => {
    const out = policy().logAttributes({ [PII_KEY]: input(c) as never });
    assert.equal(out[PII_KEY], c.token);
  });

  test(`${c.kind} "${c.name}": the resource path gives the vector's token`, async () => {
    const platform = createTestPlatform({ contextManager: () => new AsyncLocalStorageContextManager() });
    const built = await buildResource(
      {
        serviceName: "svc",
        environment: "test",
        resourceAttributes: { [PII_KEY]: input(c) as never },
      },
      { detected: {}, fromEnv: {} },
      policy(),
      platform,
    );
    assert.equal(built.resource.attributes[PII_KEY], c.token);
  });
}

test("the vectors' array and bytes cases all reach the attribute path", () => {
  // Guards the loop above: were a kind renamed in the file, its cases would silently fall away.
  for (const kind of ["string_array", "int_array", "float_array", "bool_array", "bytes"]) {
    assert.ok(
      vectors.cases.some((c) => c.kind === kind),
      `no ${kind} vector`,
    );
  }
});

// Go's rule, stated without the vector file: the root value costs one node and each element one
// more, so a top-level array keeps its first 2047 elements, and each further one is "truncated".
function elements(n: number): string[] {
  return Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26)));
}

function expectedCanonical(values: readonly string[]): string {
  const kept = values.slice(0, WALK_BUDGET - 1).map((v) => JSON.stringify(v));
  const cut = Array.from({ length: Math.max(values.length - (WALK_BUDGET - 1), 0) }, () => `"${TRUNCATED}"`);
  return `[${[...kept, ...cut].join(",")}]`;
}

for (const [n, what] of [
  [2047, "fits, with nothing truncated"],
  [2048, "has its last element truncated"],
  [5000, "has every element past the first 2047 truncated"],
] as const) {
  test(`an array of ${n} elements ${what}, with one token on every path`, async () => {
    const value = elements(n);
    const p = policy();
    const want = p.token(expectedCanonical(value));
    assert.equal(renderCanonical(value), expectedCanonical(value));
    assert.equal(p.logAttributes({ [PII_KEY]: value })[PII_KEY], want, "log record");
    assert.equal(p.attributes("traces", { [PII_KEY]: value })[PII_KEY], want, "span attribute");
    assert.equal(p.attributes("resource", { [PII_KEY]: value })[PII_KEY], want, "resource attribute");
    const built = await buildResource(
      { serviceName: "svc", environment: "test", resourceAttributes: { [PII_KEY]: value } },
      { detected: {}, fromEnv: {} },
      p,
      createTestPlatform({ contextManager: () => new AsyncLocalStorageContextManager() }),
    );
    assert.equal(built.resource.attributes[PII_KEY], want, "the resource as it is built");
  });
}

test("arrays that differ only past the budget share a token, on a span as on a log", () => {
  const a = elements(3000);
  const b = [...a];
  b[2999] = "different";
  const c = [...a];
  c[2046] = "different";
  const p = policy();
  const span = (v: string[]): unknown => p.attributes("traces", { [PII_KEY]: v })[PII_KEY];
  assert.equal(span(a), span(b), "a difference in a truncated element does not show");
  assert.notEqual(span(a), span(c), "a difference in the last kept element does");
});

test("the same oversized array gets the same token on a log record, a span, a span event and the resource", async () => {
  const value = elements(2500);
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const telemetry = await createTelemetryWith(
    {
      serviceName: "svc",
      environment: "test",
      hermetic: true,
      console: false,
      piiMode: "hash",
      piiHashKey: KEY,
      resourceAttributes: { [PII_KEY]: value },
      spanProcessor: new SimpleSpanProcessor({ exporter: spans }),
      logProcessor: new SimpleLogRecordProcessor({ exporter: logs }),
    },
    createTestPlatform({ contextManager: () => new AsyncLocalStorageContextManager() }),
  );
  try {
    telemetry.logger.info("m", { [PII_KEY]: value });
    const span = telemetry.tracerProvider.getTracer("t").startSpan("s", { attributes: { [PII_KEY]: value } });
    span.addEvent("e", { [PII_KEY]: value });
    span.end();
    // A record from another bridge on the same logger provider takes the log path too.
    telemetry.loggerProvider
      .getLogger("bridge")
      .emit({ body: "b", attributes: { [PII_KEY]: value }, context: ROOT_CONTEXT });

    const want = policy().token(expectedCanonical(value));
    const [exported] = spans.getFinishedSpans();
    assert.equal(exported?.attributes[PII_KEY], want, "span attribute");
    assert.equal(exported?.events[0]?.attributes?.[PII_KEY], want, "span event attribute");
    assert.equal(exported?.resource.attributes[PII_KEY], want, "resource attribute");
    const records = logs.getFinishedLogRecords();
    assert.equal(records.length, 2);
    assert.equal(records[0]?.attributes[PII_KEY], want, "the logger's record");
    assert.equal(records[1]?.attributes[PII_KEY], want, "a bridge's record");
  } finally {
    await telemetry.shutdown();
  }
});
