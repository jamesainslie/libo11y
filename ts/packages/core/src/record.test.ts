import assert from "node:assert/strict";
import { test } from "node:test";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
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
