import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { ConsoleSink } from "./console-sink.ts";
import { emitEvent, eventAttributes, lastWins } from "./events.ts";
import { LogPipeline } from "./logger.ts";
import { SensitivityPolicy } from "./policy.ts";

function pipeline(level: "info" | "error" = "error") {
  const lines: string[] = [];
  const p = new LogPipeline({
    level,
    policy: SensitivityPolicy.create({ pii: "drop", registries: [] }),
    console: new ConsoleSink("json", (l) => lines.push(l)),
    now: () => new Date(0),
  });
  return { p, lines };
}

test("event.name comes first and a caller's event.name is removed", () => {
  assert.deepEqual(
    Object.entries(eventAttributes("o11y.request.summary", { a: 1, "event.name": "spoof", b: 2 })),
    [
      ["event.name", "o11y.request.summary"],
      ["a", 1],
      ["b", 2],
    ],
  );
  assert.deepEqual(eventAttributes("e"), { "event.name": "e" });
});

test("an event is emitted at info past the level gate, correlated to its context", () => {
  const { p, lines } = pipeline("error");
  const ctx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: TraceFlags.SAMPLED,
  });
  emitEvent(p, "my.event", { k: "v" }, ctx);
  assert.deepEqual(lines, [
    '{"time":"1970-01-01T00:00:00Z","level":"INFO","msg":"my.event","trace_id":"0af7651916cd43dd8448eb211c80319c","span_id":"b7ad6b7169203331","event.name":"my.event","k":"v"}',
  ]);
});

test("lastWins keeps the later value at the later position", () => {
  assert.deepEqual(Object.entries(lastWins({ a: 1, b: 2, c: 3 }, { b: 20, d: 4 })), [
    ["a", 1],
    ["c", 3],
    ["b", 20],
    ["d", 4],
  ]);
});
