import assert from "node:assert/strict";
import { test } from "node:test";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { loggingErrorHandler, setGlobalErrorHandler } from "@opentelemetry/core";
import type { LogAttributes } from "./log-values.ts";
import { currentRecord, startRecord } from "./record.ts";

test("startRecord attaches a record that currentRecord finds", () => {
  const { context: ctx, record } = startRecord(ROOT_CONTEXT);
  assert.equal(currentRecord(ctx), record);
  const detached = currentRecord(ROOT_CONTEXT);
  assert.notEqual(detached, record);
  detached.set({ ignored: true });
  assert.deepEqual(currentRecord(ROOT_CONTEXT).snapshot(), {});
});

test("startRecord and currentRecord default to the active context", () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  try {
    const { context: ctx, record } = startRecord();
    context.with(ctx, () => assert.equal(currentRecord(), record));
  } finally {
    context.disable();
  }
});

test("set overwrites in first-insertion order", () => {
  const { record } = startRecord(ROOT_CONTEXT);
  record.set({ a: 1, b: "x" });
  record.set({ a: 2, c: true });
  assert.deepEqual(Object.entries(record.snapshot()), [
    ["a", 2],
    ["b", "x"],
    ["c", true],
  ]);
});

test("add sums numbers and replaces anything else", () => {
  const { record } = startRecord(ROOT_CONTEXT);
  record.add("n", 2);
  record.add("n", 3);
  record.set({ s: "text" });
  record.add("s", 4);
  assert.deepEqual(record.snapshot(), { n: 5, s: 4 });
});

test("max keeps the larger number and replaces anything else", () => {
  const { record } = startRecord(ROOT_CONTEXT);
  record.max("m", 1.5);
  record.max("m", 0.5);
  record.max("m", 2.5);
  record.set({ s: "text" });
  record.max("s", 1);
  assert.deepEqual(record.snapshot(), { m: 2.5, s: 1 });
});

test("snapshot is a copy", () => {
  const { record } = startRecord(ROOT_CONTEXT);
  record.set({ a: 1 });
  const snap = record.snapshot() as Record<string, unknown>;
  snap.a = 9;
  assert.deepEqual(record.snapshot(), { a: 1 });
});

test("emitEvent sends the snapshot plus extra attributes, which win", () => {
  const { record } = startRecord(ROOT_CONTEXT);
  record.set({ a: 1, b: 2 });
  const calls: [string, LogAttributes | undefined][] = [];
  record.emitEvent({ event: (name, attrs) => void calls.push([name, attrs]) }, "o11y.request.summary", {
    a: 10,
  });
  assert.deepEqual(calls.length, 1);
  assert.equal(calls[0]?.[0], "o11y.request.summary");
  assert.deepEqual(Object.entries(calls[0]?.[1] ?? {}), [
    ["b", 2],
    ["a", 10],
  ]);
});

test("a record from another copy of core is found through the shared brand", () => {
  const foreign = {
    [Symbol.for("libo11y.wide-record")]: true,
    set() {},
    add() {},
    max() {},
    snapshot: () => ({ from: "elsewhere" }),
    emitEvent() {},
  };
  const ctx = ROOT_CONTEXT.setValue(Symbol.for("libo11y.record"), foreign);
  assert.equal(currentRecord(ctx), foreign);
  const unbranded = ROOT_CONTEXT.setValue(Symbol.for("libo11y.record"), { snapshot: () => ({}) });
  assert.notEqual(currentRecord(unbranded).snapshot, undefined);
  assert.deepEqual(currentRecord(unbranded).snapshot(), {});
  const { context: own } = startRecord(ROOT_CONTEXT);
  assert.equal(
    (currentRecord(own) as unknown as Record<symbol, unknown>)[Symbol.for("libo11y.wide-record")],
    true,
  );
});

// Third review: a wide record's mutators and emitEvent are called from application code, in a
// request handler, and must never throw into it. They get the logger's treatment: each attribute is
// read once, what cannot be read is dropped and reported, and the report never carries the message
// of what was thrown.
const MARKER = "sk_live_MARKER_wide";

function revoked(): never {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy as never;
}

/** Captures what reaches the OpenTelemetry global error handler while fn runs. */
function capturingGlobal(fn: () => void): Error[] {
  const reports: Error[] = [];
  setGlobalErrorHandler((err) => {
    reports.push(err as Error);
  });
  try {
    fn();
  } finally {
    setGlobalErrorHandler(loggingErrorHandler());
  }
  return reports;
}

test("set never throws: an attribute that cannot be read is dropped and reported, and the rest is kept", () => {
  const { record } = startRecord(ROOT_CONTEXT);
  let reads = 0;
  const thrown = new RangeError(`no row for ${MARKER}`);
  const reports = capturingGlobal(() => {
    assert.doesNotThrow(() =>
      record.set({
        before: 1,
        get bad(): string {
          throw thrown;
        },
        get counted(): number {
          reads++;
          return reads;
        },
        after: 2,
      }),
    );
    assert.doesNotThrow(() => record.set(revoked()));
    assert.doesNotThrow(() => record.set(null as never));
    assert.doesNotThrow(() => record.set(undefined as never));
  });
  assert.deepEqual(record.snapshot(), { before: 1, counted: 1, after: 2 });
  assert.equal(reads, 1, "each attribute is read once");
  assert.deepEqual(
    reports.map((r) => r.message),
    [
      'o11y: wide record attribute "bad" cannot be read and is dropped: RangeError',
      "o11y: wide record attributes cannot be read and are dropped: TypeError",
    ],
  );
  assert.equal(reports[0]?.cause, thrown);
  for (const r of reports) assert.ok(!`${r.message}${r.stack}`.includes("MARKER"));
});

test("add and max never throw, and leave the value as it was when they cannot compute", () => {
  const { record } = startRecord(ROOT_CONTEXT);
  record.set({ n: 2, m: 2 });
  const hostile = {
    valueOf(): number {
      throw new Error(MARKER);
    },
  };
  const key = {
    toString(): string {
      throw new Error(MARKER);
    },
  };
  const reports = capturingGlobal(() => {
    assert.doesNotThrow(() => record.add("n", hostile as never));
    assert.doesNotThrow(() => record.max("m", hostile as never));
    assert.doesNotThrow(() => record.add(key as never, 1));
    assert.doesNotThrow(() => record.max(key as never, 1));
  });
  assert.deepEqual(record.snapshot(), { n: 2, m: 2 });
  assert.deepEqual(
    reports.map((r) => r.message),
    [
      "o11y: wide record add failed, the value is unchanged: Error",
      "o11y: wide record max failed, the value is unchanged: Error",
      "o11y: wide record add failed, the value is unchanged: Error",
      "o11y: wide record max failed, the value is unchanged: Error",
    ],
  );
  record.add("n", 3);
  record.max("m", 7);
  assert.deepEqual(record.snapshot(), { n: 5, m: 7 });
});

test("emitEvent never throws: unreadable extra attributes are dropped, and the event still goes out", () => {
  const { record } = startRecord(ROOT_CONTEXT);
  record.set({ a: 1 });
  const calls: [string, LogAttributes | undefined][] = [];
  const viaHandle: string[] = [];
  const telemetry = {
    event: (name: string, attrs?: LogAttributes) => void calls.push([name, attrs]),
    [Symbol.for("libo11y.report")]: (err: unknown) => void viaHandle.push((err as Error).message),
  };
  const viaGlobal = capturingGlobal(() => {
    assert.doesNotThrow(() => record.emitEvent(telemetry, "e1", revoked()));
    assert.doesNotThrow(() =>
      record.emitEvent(telemetry, "e2", {
        b: 2,
        get bad(): string {
          throw new Error(MARKER);
        },
      }),
    );
  });
  assert.deepEqual(calls, [
    ["e1", { a: 1 }],
    ["e2", { a: 1, b: 2 }],
  ]);
  assert.deepEqual(viaHandle, [
    "o11y: wide record attributes cannot be read and are dropped: TypeError",
    'o11y: wide record attribute "bad" cannot be read and is dropped: Error',
  ]);
  assert.deepEqual(viaGlobal, [], "a telemetry that carries a reporter gets the reports");
});

test("emitEvent contains an emitter that throws or is not one, and reports to the global handler without a handle", () => {
  const { record } = startRecord(ROOT_CONTEXT);
  const reports = capturingGlobal(() => {
    assert.doesNotThrow(() =>
      record.emitEvent(
        {
          event: () => {
            throw new Error(MARKER);
          },
        },
        "e",
      ),
    );
    assert.doesNotThrow(() => record.emitEvent(undefined as never, "e"));
    assert.doesNotThrow(() => record.emitEvent({ event: () => {} }, "e", revoked()));
  });
  assert.deepEqual(
    reports.map((r) => r.message),
    [
      "o11y: emitting a wide record's event failed: Error",
      "o11y: emitting a wide record's event failed: TypeError",
      "o11y: wide record attributes cannot be read and are dropped: TypeError",
    ],
  );
});

test("a detached record takes the same calls without throwing", () => {
  const detached = currentRecord(ROOT_CONTEXT);
  const reports = capturingGlobal(() => {
    assert.doesNotThrow(() => detached.set(revoked()));
    assert.doesNotThrow(() => detached.emitEvent({ event: () => {} }, "e", revoked()));
  });
  assert.equal(reports.length, 2);
});
