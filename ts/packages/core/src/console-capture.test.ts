import assert from "node:assert/strict";
import { test } from "node:test";
import { captureConsole, formatConsoleArgs } from "./console-capture.ts";
import { ConsoleSink } from "./console-sink.ts";
import { CoreLogger, LogPipeline } from "./logger.ts";
import type { PlatformConsole } from "./platform.ts";
import { SensitivityPolicy } from "./policy.ts";

const METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

function fakeConsole() {
  const calls: [string, unknown[]][] = [];
  const target = Object.fromEntries(
    METHODS.map((m) => [m, (...args: unknown[]) => void calls.push([m, args])]),
  ) as unknown as PlatformConsole;
  return { target, calls };
}

function harness(write?: (line: string, target: PlatformConsole) => void) {
  const { target, calls } = fakeConsole();
  const lines: string[] = [];
  const pipeline = new LogPipeline({
    level: "trace",
    policy: SensitivityPolicy.create({ pii: "drop", registries: [] }),
    console: new ConsoleSink("json", (line) => {
      lines.push(line);
      write?.(line, target);
    }),
    now: () => new Date(0),
  });
  return { target, calls, lines, logger: new CoreLogger(pipeline) };
}

function parsed(line: string | undefined): Record<string, unknown> {
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

test("each console method maps to its level and carries o11y.log.source=console", () => {
  const { target, calls, lines, logger } = harness();
  const restore = captureConsole(target, logger);
  target.log("a");
  target.info("b");
  target.warn("c");
  target.error("d");
  target.debug("e");
  target.trace("f");
  restore();
  assert.deepEqual(
    lines.map((l) => [parsed(l).level, parsed(l).msg, parsed(l)["o11y.log.source"]]),
    [
      ["INFO", "a", "console"],
      ["INFO", "b", "console"],
      ["WARN", "c", "console"],
      ["ERROR", "d", "console"],
      ["DEBUG", "e", "console"],
      ["TRACE", "f", "console"],
    ],
  );
  assert.deepEqual(calls, [], "a captured call never reaches the original method");
});

test("messages are formatted like util.format", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  const cases: [unknown[], string][] = [
    [["plain"], "plain"],
    [["%s is %d years", "Bob", 42], "Bob is 42 years"],
    [["%i|%f|%d", "42.9", "1.5", "x"], "42|1.5|NaN"],
    [["%j", { a: [1, "b"] }], '{"a":[1,"b"]}'],
    [["%o and %O", { x: 1 }, [2]], '{"x":1} and [2]'],
    [["%c styled", "color: red"], " styled"],
    [["100%% sure"], "100% sure"],
    [["%s and %s", "one"], "one and %s"],
    [["extra", 1, true, null, undefined, { k: "v" }], 'extra 1 true null undefined {"k":"v"}'],
    [[{ k: "v" }, "second"], '{"k":"v"} second'],
    [["%j", cyclic], '{"a":1,"self":"[Circular]"}'],
    [[12n, "%d", 3n], "12n %d 3n"],
    [["%d", 7n], "7n"],
    [[], ""],
  ];
  for (const [args, want] of cases) assert.equal(formatConsoleArgs(args), want, JSON.stringify(String(args)));
});

test("the first Error argument expands to exception.*", () => {
  const { target, lines, logger } = harness();
  const restore = captureConsole(target, logger);
  target.error("request failed:", new TypeError("bad"), new Error("second"));
  restore();
  const rec = parsed(lines[0]);
  assert.equal(rec.msg, "request failed: TypeError: bad Error: second");
  assert.equal(rec["exception.type"], "TypeError");
  assert.equal(rec["exception.message"], "bad");
  assert.equal(typeof rec["exception.stacktrace"], "string");
  assert.equal(rec["o11y.log.source"], "console");
});

test("a console call made inside a capture goes to the original method", () => {
  const { target, calls, lines, logger } = harness((_line, t) => t.warn("from the sink"));
  const restore = captureConsole(target, logger);
  target.info("outer");
  restore();
  assert.equal(lines.length, 1);
  assert.deepEqual(calls, [["warn", ["from the sink"]]]);
});

test("restore puts every original method back", () => {
  const { target, calls, lines, logger } = harness();
  const originals = METHODS.map((m) => target[m]);
  const restore = captureConsole(target, logger);
  assert.ok(METHODS.every((m, i) => target[m] !== originals[i]));
  restore();
  assert.ok(METHODS.every((m, i) => target[m] === originals[i]));
  target.log("after");
  assert.equal(lines.length, 0);
  assert.deepEqual(calls, [["log", ["after"]]]);
  restore(); // a second restore is harmless
  assert.ok(METHODS.every((m, i) => target[m] === originals[i]));
});
