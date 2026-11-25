/**
 * Option validation. Third review: a value outside an option's closed set was accepted in silence.
 * logLevel "verbose" dropped every record, error and fatal included, console "pretty" wrote text,
 * and a boolean given as the string "false" was taken as true. TypeScript callers get a compile
 * error. JavaScript callers and values read from configuration did not get anything.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { validateOptions } from "./config.ts";
import { O11yError } from "./errors.ts";
import type { TelemetryOptions } from "./options.ts";
import { createTelemetryWith, setupWith } from "./telemetry.ts";
import { createTestPlatform } from "./testing.ts";

const OPTIONS: TelemetryOptions = { serviceName: "svc", serviceVersion: "1.2.3", environment: "test" };
const GUARD = Symbol.for("libo11y.setup");

function platform() {
  return createTestPlatform({ contextManager: () => new AsyncLocalStorageContextManager() });
}

function invalid(message: string): (err: unknown) => boolean {
  return (err) => {
    assert.ok(err instanceof O11yError, String(err));
    assert.equal(err.code, "INVALID_OPTION");
    assert.equal(err.message, message);
    return true;
  };
}

const LEVELS = "trace, debug, info, warn, error, fatal";
const BOOLEANS = [
  "strictIdentity",
  "captureConsole",
  "logExport",
  "runtimeMetrics",
  "startupSummary",
  "hermetic",
];

/** Each option with a closed set of values, a value outside it, and the message it is refused with. */
const REFUSED: readonly [option: string, value: unknown, message: string][] = [
  ["logLevel", "verbose", `o11y: invalid option logLevel: "verbose" (allowed: ${LEVELS})`],
  ["logLevel", "INFO", `o11y: invalid option logLevel: "INFO" (allowed: ${LEVELS})`],
  ["logLevel", "", `o11y: invalid option logLevel: "" (allowed: ${LEVELS})`],
  ["logLevel", 9, `o11y: invalid option logLevel: 9 (allowed: ${LEVELS})`],
  ["logLevel", "toString", `o11y: invalid option logLevel: "toString" (allowed: ${LEVELS})`],
  ["console", "pretty", 'o11y: invalid option console: "pretty" (allowed: json, text, false)'],
  ["console", true, "o11y: invalid option console: true (allowed: json, text, false)"],
  ["console", "false", 'o11y: invalid option console: "false" (allowed: json, text, false)'],
  ["piiMode", "bogus", 'o11y: invalid option piiMode: "bogus" (allowed: drop, hash, allow)'],
  ["piiMode", "ALLOW", 'o11y: invalid option piiMode: "ALLOW" (allowed: drop, hash, allow)'],
  ["piiMode", false, "o11y: invalid option piiMode: false (allowed: drop, hash, allow)"],
  [
    "exemplarFilter",
    "sometimes",
    'o11y: invalid option exemplarFilter: "sometimes" (allowed: trace_based, always_on, always_off)',
  ],
  [
    "exemplarFilter",
    {},
    "o11y: invalid option exemplarFilter: an object (allowed: trace_based, always_on, always_off)",
  ],
  ...BOOLEANS.flatMap((option): [string, unknown, string][] => [
    [option, "false", `o11y: invalid option ${option}: "false" (allowed: true, false)`],
    [option, 0, `o11y: invalid option ${option}: 0 (allowed: true, false)`],
  ]),
];

for (const [option, value, message] of REFUSED) {
  test(`${option}: ${JSON.stringify(value)} is refused by createTelemetryWith and setupWith`, async () => {
    const options = { ...OPTIONS, [option]: value } as TelemetryOptions;
    await assert.rejects(createTelemetryWith(options, platform()), invalid(message));
    await assert.rejects(setupWith(options, platform()), invalid(message));
    assert.equal((globalThis as Record<symbol, unknown>)[GUARD], undefined, "setup gave the guard back");
  });
}

test("every value in an option's set is accepted", async () => {
  const accepted: Record<string, readonly unknown[]> = {
    logLevel: ["trace", "debug", "info", "warn", "error", "fatal"],
    console: ["json", "text", false],
    piiMode: ["drop", "allow"],
    exemplarFilter: ["trace_based", "always_on", "always_off"],
    ...Object.fromEntries(BOOLEANS.map((option) => [option, [true, false]])),
  };
  for (const [option, values] of Object.entries(accepted)) {
    for (const value of values) {
      const t = await createTelemetryWith({ ...OPTIONS, [option]: value } as TelemetryOptions, platform());
      await t.shutdown();
    }
  }
  const hashed = await createTelemetryWith(
    { ...OPTIONS, piiMode: "hash", piiHashKey: new Uint8Array(32).fill(1) },
    platform(),
  );
  await hashed.shutdown();
});

test("an option that is undefined or null is not given, and takes its default", async () => {
  const blank = Object.fromEntries(
    ["logLevel", "console", "piiMode", "exemplarFilter", ...BOOLEANS].flatMap((option) => [[option, null]]),
  );
  for (const options of [blank, Object.fromEntries(Object.keys(blank).map((k) => [k, undefined]))]) {
    const p = platform();
    const t = await createTelemetryWith({ ...OPTIONS, ...options } as TelemetryOptions, p);
    t.logger.info("kept");
    t.logger.debug("gated");
    await t.shutdown();
    assert.deepEqual(
      p.lines.map((l) => (JSON.parse(l) as { msg: string }).msg),
      ["kept"],
      "the default level is info and the default console is json",
    );
  }
});

test("the first invalid option is reported, in the order the options are documented", () => {
  assert.throws(
    () => validateOptions({ piiMode: "x", logLevel: "y", console: "z" } as never),
    invalid('o11y: invalid option piiMode: "x" (allowed: drop, hash, allow)'),
  );
  assert.doesNotThrow(() => validateOptions({}));
  assert.doesNotThrow(() => validateOptions(OPTIONS));
});

test("a value that cannot be printed is described by its type, never by its text", () => {
  const hostile = {
    toString() {
      throw new Error("no");
    },
  };
  for (const [value, text] of [
    [hostile, "an object"],
    [["info"], "an array"],
    [() => "info", "a function"],
    [Symbol("info"), "a symbol"],
    [12n, "12"],
    [Number.NaN, "NaN"],
  ] as const) {
    assert.throws(
      () => validateOptions({ logLevel: value } as never),
      invalid(`o11y: invalid option logLevel: ${text} (allowed: ${LEVELS})`),
    );
  }
});

test("before validation, logLevel verbose dropped every record: now nothing is built with it", async () => {
  const p = platform();
  await assert.rejects(createTelemetryWith({ ...OPTIONS, logLevel: "verbose" as never }, p));
  assert.deepEqual(p.lines, []);
  assert.deepEqual(p.diagnostics, []);
});

// Fourth review: the propagators option was not checked. A single propagator where an array is
// expected has no length, so it read as "not given" and the default was used in silence.
const PROPAGATOR = { inject: () => {}, extract: <T>(ctx: T): T => ctx, fields: () => ["x-custom"] };
const WANTED = "an array of propagators";

test("a propagators option that is not an array is refused, where it used to be ignored", async () => {
  for (const [value, text] of [
    [PROPAGATOR, "an object"],
    ["tracecontext", '"tracecontext"'],
    ["tracecontext,baggage", '"tracecontext,baggage"'],
    [1, "1"],
    [true, "true"],
    [new Set([PROPAGATOR]), "an object"],
    [{ length: 1, 0: PROPAGATOR }, "an object"],
    [() => [PROPAGATOR], "a function"],
  ] as const) {
    const refused = invalid(`o11y: invalid option propagators: ${text} (allowed: ${WANTED})`);
    assert.throws(() => validateOptions({ propagators: value } as never), refused);
    const p = platform();
    await assert.rejects(createTelemetryWith({ ...OPTIONS, propagators: value } as never, p), refused);
    await assert.rejects(setupWith({ ...OPTIONS, propagators: value } as never, platform()), refused);
    assert.deepEqual(p.lines, [], "nothing was built");
  }
  assert.equal((globalThis as Record<symbol, unknown>)[GUARD], undefined, "setup gave the guard back");
});

test("a propagators array is checked member by member, and the first that is not a propagator is named", () => {
  const WANTED_MEMBER = "a propagator with inject, extract and fields";
  for (const [value, index, text] of [
    [["tracecontext", "baggage"], 0, '"tracecontext"'],
    [[PROPAGATOR, "baggage"], 1, '"baggage"'],
    [[PROPAGATOR, null], 1, "null"],
    [[undefined], 0, "undefined"],
    [[{ inject: () => {}, extract: () => {} }], 0, "an object"],
    [[{ ...PROPAGATOR, fields: ["x-custom"] }], 0, "an object"],
    [[[PROPAGATOR]], 0, "an array"],
  ] as const) {
    assert.throws(
      () => validateOptions({ propagators: value } as never),
      invalid(`o11y: invalid option propagators[${index}]: ${text} (allowed: ${WANTED_MEMBER})`),
    );
  }
});

test("a propagators option that is an array of propagators, empty, undefined or null is accepted", async () => {
  class Custom {
    inject(): void {}
    extract<T>(ctx: T): T {
      return ctx;
    }
    fields(): string[] {
      return ["x-class"];
    }
  }
  for (const value of [[PROPAGATOR], [new Custom()], [PROPAGATOR, new Custom()], [], undefined, null]) {
    assert.doesNotThrow(() => validateOptions({ propagators: value } as never));
  }
  const t = await createTelemetryWith({ ...OPTIONS, propagators: [new Custom()] } as never, platform());
  assert.deepEqual(t.propagator.fields(), ["x-class"]);
  await t.shutdown();
  // Null is not given: the default applies.
  const unset = await createTelemetryWith({ ...OPTIONS, propagators: null } as never, platform());
  assert.deepEqual(unset.propagator.fields(), ["traceparent", "tracestate", "baggage"]);
  await unset.shutdown();
});

// Fourth review: the message echoed a string value whole, however long. A value read from the
// environment or a file can be anything, and a setup error is logged where it is caught.
test("a long value is shortened in the message, which says so", () => {
  const long = `${"v".repeat(40)}${"é".repeat(40)}SECRET-TAIL`;
  assert.throws(
    () => validateOptions({ logLevel: long } as never),
    invalid(
      `o11y: invalid option logLevel: "${"v".repeat(40)}${"é".repeat(24)}" (the first 64 of ${long.length} characters) (allowed: ${LEVELS})`,
    ),
  );
  // Exactly at the limit, the value is whole and nothing is said.
  const atLimit = "x".repeat(64);
  assert.throws(
    () => validateOptions({ logLevel: atLimit } as never),
    invalid(`o11y: invalid option logLevel: "${atLimit}" (allowed: ${LEVELS})`),
  );
  // A character outside the basic plane is kept or left out whole, never cut in two.
  const pairs = "😀".repeat(70);
  assert.throws(
    () => validateOptions({ console: pairs } as never),
    invalid(
      `o11y: invalid option console: "${"😀".repeat(64)}" (the first 64 of 70 characters) (allowed: json, text, false)`,
    ),
  );
  // A bigint prints as long as it is.
  const big = 10n ** 200n;
  assert.throws(
    () => validateOptions({ logLevel: big } as never),
    invalid(
      `o11y: invalid option logLevel: ${"1".padEnd(64, "0")} (the first 64 of 201 characters) (allowed: ${LEVELS})`,
    ),
  );
  // A megabyte of text costs the message nothing.
  const huge = "h".repeat(1_000_000);
  assert.throws(
    () => validateOptions({ piiMode: huge } as never),
    (err: unknown) => err instanceof O11yError && err.message.length < 200,
  );
});
