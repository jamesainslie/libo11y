/**
 * The PII hash key is bytes, and only bytes.
 *
 * Fourth review, security: a key given as a string produced unkeyed tokens. The length check passed
 * because a 32-character string has length 32, and `new Uint8Array(string)` is an empty array, so
 * every token was HMAC-SHA256 under the empty key, which anyone can compute. A caller who wrote
 * `piiHashKey: process.env.PII_HASH_KEY` in JavaScript, or with a cast in TypeScript, got tokens
 * that enumeration reverses.
 *
 * A key that is not a Uint8Array is rejected in every PII mode before anything is built, the
 * message never carries the key, and the policy drops a value when it holds no usable key.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { validateOptions } from "./config.ts";
import { O11yError } from "./errors.ts";
import { buildResource } from "./identity.ts";
import { isBytes } from "./internal/bytes.ts";
import type { TelemetryOptions } from "./options.ts";
import { type PIIMode, SensitivityPolicy } from "./policy.ts";
import { createTelemetryWith, setupWith } from "./telemetry.ts";
import { createTestPlatform, type TestPlatform } from "./testing.ts";

const vectors = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "..", "..", "..", "..", "conformance", "vectors", "pii-hash.json"),
    "utf8",
  ),
) as { key_hex: string; cases: { name: string; kind: string; value: unknown; token: string }[] };

const OPTIONS: TelemetryOptions = {
  serviceName: "svc",
  serviceVersion: "1",
  environment: "test",
  hermetic: true,
  startupSummary: false,
};
const GUARD = Symbol.for("libo11y.setup");

/** A PII key in the specification's table, so hash mode rewrites its value to a token. */
const PII_KEY = "host.ip";
const PII_VALUE = "10.1.2.3";

/** What a platform was asked to do, so a test can show nothing was built. */
function watched(): { platform: TestPlatform; calls: string[] } {
  const calls: string[] = [];
  const platform = createTestPlatform({
    contextManager: () => {
      calls.push("contextManager");
      return new AsyncLocalStorageContextManager();
    },
    env: () => {
      calls.push("env");
      return {};
    },
    detectResource: async () => {
      calls.push("detectResource");
      return { detected: {}, fromEnv: {} };
    },
    buildExporters: () => {
      calls.push("buildExporters");
      return {};
    },
  });
  return { platform, calls };
}

/** The token a telemetry built with key puts on a log record for the PII value. */
async function tokenUnder(key: unknown, value: string = PII_VALUE): Promise<unknown> {
  const { platform } = watched();
  const telemetry = await createTelemetryWith(
    { ...OPTIONS, piiMode: "hash", piiHashKey: key as Uint8Array },
    platform,
  );
  try {
    telemetry.logger.info("m", { [PII_KEY]: value });
    const line = platform.lines.find((l) => l.includes('"msg":"m"'));
    assert.ok(line !== undefined, "the record reached the console sink");
    return (JSON.parse(line) as Record<string, unknown>)[PII_KEY];
  } finally {
    await telemetry.shutdown();
  }
}

/** HMAC-SHA256 as the specification defines the token, from node:crypto and not from the library. */
function reference(key: string | Uint8Array, value: string): string {
  return `hmac-sha256:${createHmac("sha256", key).update(value, "utf8").digest("hex").slice(0, 32)}`;
}

/** Fails when message carries any four characters in a row of secret. */
function assertNoEcho(message: string, secret: string, label: string): void {
  for (let i = 0; i + 4 <= secret.length; i++) {
    const part = secret.slice(i, i + 4);
    assert.ok(!message.includes(part), `${label}: the message carries ${JSON.stringify(part)}: ${message}`);
  }
}

let stringified = 0;
const telling = {
  length: 32,
  secret: "OBJ#SECRET#VALUE",
  toString(): string {
    stringified++;
    return "TOSTRING#SECRET";
  },
  toJSON(): string {
    stringified++;
    return "TOJSON#SECRET";
  },
};

/** Keys that are not bytes, each with the text of it a careless message would print. */
const NOT_BYTES: readonly { name: string; key: unknown; secrets: readonly string[] }[] = [
  {
    name: "a 32-character string",
    key: "S3CR3T+KEY+MATERIAL+ZYXWVUTSRQPO",
    secrets: ["S3CR3T+KEY+MATERIAL+ZYXWVUTSRQPO"],
  },
  {
    name: "a 64-character hex string",
    key: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    secrets: ["9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
  },
  {
    name: "a numeric string, which new Uint8Array reads as a length",
    key: "4096",
    secrets: ["4096"],
  },
  {
    name: "an array of numbers",
    key: Array.from({ length: 32 }, (_, i) => 201 + i),
    secrets: [Array.from({ length: 32 }, (_, i) => 201 + i).join(","), "201", "232"],
  },
  { name: "an ArrayBuffer", key: new Uint8Array(32).fill(0xab).buffer, secrets: ["171", "0xab"] },
  { name: "a number", key: 7_654_321_098, secrets: ["7654321098"] },
  { name: "a bigint", key: 7_654_321_098n, secrets: ["7654321098"] },
  { name: "a boolean", key: true, secrets: [] },
  { name: "an object", key: telling, secrets: ["OBJ#SECRET#VALUE", "TOSTRING#SECRET", "TOJSON#SECRET"] },
  { name: "a function", key: () => "FUNCTION#SECRET", secrets: ["FUNCTION#SECRET"] },
  { name: "a Uint16Array", key: new Uint16Array(32).fill(0x4142), secrets: ["16706", "4142"] },
  { name: "a Uint8ClampedArray", key: new Uint8ClampedArray(32).fill(7), secrets: [] },
  { name: "a DataView", key: new DataView(new ArrayBuffer(32)), secrets: [] },
];

const MODES: readonly (PIIMode | undefined)[] = [undefined, "drop", "hash", "allow"];

function rejectedAsNotBytes(c: { name: string; secrets: readonly string[] }): (err: unknown) => boolean {
  return (err: unknown): boolean => {
    assert.ok(err instanceof O11yError, `${c.name}: an O11yError, got ${String(err)}`);
    assert.equal(err.code, "PII_HASH_KEY", c.name);
    assert.match(err.message, /bytes/, `${c.name}: the message says the key has to be bytes`);
    assert.match(err.message, /Uint8Array/, `${c.name}: the message names the type to pass`);
    for (const secret of c.secrets) assertNoEcho(err.message, secret, c.name);
    assert.equal(err.cause, undefined, `${c.name}: nothing rides on the cause`);
    return true;
  };
}

for (const c of NOT_BYTES) {
  for (const mode of MODES) {
    test(`createTelemetry rejects ${c.name} as the key, piiMode ${mode ?? "unset"}`, async () => {
      const { platform, calls } = watched();
      const options = { ...OPTIONS, ...(mode === undefined ? {} : { piiMode: mode }), piiHashKey: c.key };
      await assert.rejects(createTelemetryWith(options as never, platform), rejectedAsNotBytes(c));
      assert.deepEqual(calls, [], "nothing was built");
      assert.deepEqual(platform.lines, []);
    });
  }

  test(`setup rejects ${c.name} as the key and leaves no guard behind`, async () => {
    const { platform, calls } = watched();
    await assert.rejects(
      setupWith({ ...OPTIONS, piiMode: "hash", piiHashKey: c.key } as never, platform),
      rejectedAsNotBytes(c),
    );
    assert.deepEqual(calls, [], "nothing was built");
    assert.equal((globalThis as Record<symbol, unknown>)[GUARD], undefined, "the setup guard is released");
  });

  test(`the policy itself rejects ${c.name} as the key in every mode`, () => {
    for (const pii of ["drop", "hash", "allow"] as const) {
      assert.throws(
        () => SensitivityPolicy.create({ pii, key: c.key as Uint8Array, registries: [] }),
        rejectedAsNotBytes(c),
        pii,
      );
    }
  });
}

test("no rejected key was turned into text", () => {
  assert.equal(stringified, 0);
});

test("option validation alone rejects a key that is not bytes", () => {
  assert.throws(
    () => validateOptions({ piiHashKey: "S3CR3T+KEY+MATERIAL+ZYXWVUTSRQPO" } as never),
    (err: unknown) => err instanceof O11yError && err.code === "PII_HASH_KEY",
  );
  assert.doesNotThrow(() => validateOptions({ piiHashKey: new Uint8Array(32) }));
  // Not given: undefined, and null as the other options read it.
  assert.doesNotThrow(() => validateOptions({ piiHashKey: undefined } as never));
  assert.doesNotThrow(() => validateOptions({ piiHashKey: null } as never));
});

test("hash mode with a null key is still rejected: no key was given", async () => {
  await assert.rejects(
    createTelemetryWith({ ...OPTIONS, piiMode: "hash", piiHashKey: null } as never, watched().platform),
    (err: unknown) => err instanceof O11yError && err.code === "PII_HASH_KEY",
  );
});

// The reviewer's finding, as it was observed: different string keys, one token, the empty key's.
// The bytes of those strings are real keys. (32 zero bytes are left out on purpose: HMAC pads a
// short key with zeros, so an all-zero key is the empty key by definition, in every library.)
test("the bytes of different keys give different tokens, none of them the empty key's", async () => {
  const unkeyed = reference("", PII_VALUE);
  const a = new TextEncoder().encode("S3CR3T+KEY+MATERIAL+ZYXWVUTSRQPO");
  const b = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
  const c = new Uint8Array(32).fill(1);
  const tokens = [await tokenUnder(a), await tokenUnder(b), await tokenUnder(c)];
  assert.deepEqual(tokens, [reference(a, PII_VALUE), reference(b, PII_VALUE), reference(c, PII_VALUE)]);
  assert.equal(new Set(tokens).size, 3, "each key gives its own token");
  for (const token of tokens) assert.notEqual(token, unkeyed);
});

test("a Uint8Array and a Buffer of the same bytes are both accepted and give the same keyed token", async () => {
  const bytes = new Uint8Array(32).map((_, i) => 0xa0 + i);
  const want = reference(bytes, PII_VALUE);
  assert.equal(await tokenUnder(bytes), want, "Uint8Array");
  assert.equal(await tokenUnder(Buffer.from(bytes)), want, "Buffer");
  assert.equal(await tokenUnder(Buffer.from(Buffer.from(bytes).toString("hex"), "hex")), want, "hex");
  assert.equal(
    await tokenUnder(Buffer.from(Buffer.from(bytes).toString("base64"), "base64")),
    want,
    "base64",
  );
  // A view into a larger buffer keys with its own bytes only.
  const wide = new Uint8Array(96).fill(0xff);
  wide.set(bytes, 32);
  assert.equal(await tokenUnder(wide.subarray(32, 64)), want, "a view at an offset");
  class Key extends Uint8Array {}
  assert.equal(await tokenUnder(Key.from(bytes)), want, "a subclass of Uint8Array");
});

// A test runner that loads the library inside a vm context hands it a Buffer whose Uint8Array is
// another realm's, which instanceof does not recognise. Such a key is bytes all the same.
test("a Uint8Array from another realm is accepted", async () => {
  const foreign = runInNewContext("new Uint8Array(32).map((_, i) => 0xa0 + i)") as Uint8Array;
  const local = new Uint8Array(32).map((_, i) => 0xa0 + i);
  assert.equal(isBytes(foreign), true);
  assert.equal(await tokenUnder(foreign), reference(local, PII_VALUE));
});

test("isBytes reads the type and not what an object claims to be", () => {
  assert.equal(isBytes(new Uint8Array(0)), true);
  assert.equal(isBytes(Buffer.alloc(1)), true);
  const claims = {
    length: 32,
    [Symbol.toStringTag]: "Uint8Array",
    constructor: Uint8Array,
    BYTES_PER_ELEMENT: 1,
  };
  assert.equal(isBytes(claims), false, "an object with the tag of one");
  const wide = new Uint16Array(32);
  Object.defineProperty(wide, Symbol.toStringTag, { value: "Uint8Array" });
  assert.equal(isBytes(wide), false, "another typed array with the tag of one");
  assert.equal(isBytes(Object.create(Uint8Array.prototype)), false, "an object on the prototype");
  for (const v of [undefined, null, "", "x".repeat(32), 32, [], new ArrayBuffer(32)]) {
    assert.equal(isBytes(v), false, String(v));
  }
});

test("the token for the shared vector's value under its 32-byte key is the vector's token", async () => {
  const email = vectors.cases.find((c) => c.name === "email");
  assert.ok(email !== undefined && typeof email.value === "string");
  assert.equal(vectors.key_hex.length, 64, "a 32-byte key");
  const key = Buffer.from(vectors.key_hex, "hex");
  assert.equal(await tokenUnder(key, email.value), email.token, "a Buffer decoded from hex");
  assert.equal(await tokenUnder(Uint8Array.from(key), email.value), email.token, "a Uint8Array");
  assert.equal(email.token, reference(key, email.value), "and it is HMAC-SHA256 under that key");
});

test("hash mode still needs 32 bytes, and the other modes take a short key they never use", async () => {
  for (const key of [new Uint8Array(0), new Uint8Array(31), Buffer.alloc(31, 1)]) {
    await assert.rejects(
      createTelemetryWith({ ...OPTIONS, piiMode: "hash", piiHashKey: key }, watched().platform),
      (err: unknown) => err instanceof O11yError && err.code === "PII_HASH_KEY",
    );
  }
  for (const piiMode of ["drop", "allow"] as const) {
    const telemetry = await createTelemetryWith(
      { ...OPTIONS, piiMode, piiHashKey: new Uint8Array(8) },
      watched().platform,
    );
    await telemetry.shutdown();
  }
});

// Safe by construction: whatever a future caller does, the policy never keys an HMAC with
// something that is not at least 32 bytes. It drops the value instead.

const calls: unknown[] = [];
const spy = (key: Uint8Array, data: Uint8Array): Uint8Array => {
  calls.push(key);
  return new Uint8Array(createHmac("sha256", key).update(data).digest());
};

/** A policy built around create's checks, as a future caller with a new code path might hold one. */
function forced(pii: PIIMode, key: unknown): SensitivityPolicy {
  return Reflect.construct(SensitivityPolicy as never, [pii, key, new Map(), spy, undefined]);
}

const UNUSABLE: readonly { name: string; key: unknown }[] = [
  { name: "no key", key: undefined },
  { name: "null", key: null },
  { name: "an empty Uint8Array", key: new Uint8Array(0) },
  { name: "31 bytes", key: new Uint8Array(31).fill(1) },
  { name: "a 32-character string", key: "S3CR3T+KEY+MATERIAL+ZYXWVUTSRQPO" },
  { name: "an array of 32 numbers", key: Array.from({ length: 32 }, (_, i) => i) },
  { name: "an ArrayBuffer", key: new ArrayBuffer(32) },
  { name: "the number 32", key: 32 },
];

for (const c of UNUSABLE) {
  test(`a hash policy holding ${c.name} drops the value on every path and keys no HMAC`, async () => {
    calls.length = 0;
    const policy = forced("hash", c.key);
    assert.equal(policy.token("x"), undefined, "token");
    assert.equal(policy.tokenOf(PII_VALUE), undefined, "tokenOf");
    assert.deepEqual(policy.attributes("traces", { [PII_KEY]: PII_VALUE, ok: 1 }), { ok: 1 }, "span");
    assert.deepEqual(policy.logAttributes({ [PII_KEY]: PII_VALUE, ok: 1 }), { ok: 1 }, "log");
    assert.deepEqual(
      policy.logAttributes({ host: { ip: PII_VALUE, name: "h" } }),
      { host: { name: "h" } },
      "a member of a log group",
    );
    assert.deepEqual(
      policy.logAttributes({ host: [{ ip: PII_VALUE, name: "h" }, { ip: PII_VALUE }] }),
      { host: [{ name: "h" }] },
      "a member of a group in a log array",
    );
    const built = await buildResource(
      { ...OPTIONS, resourceAttributes: { [PII_KEY]: PII_VALUE, "deployment.region": "eu" } },
      { detected: {}, fromEnv: {} },
      policy,
      watched().platform,
    );
    assert.equal(PII_KEY in built.resource.attributes, false, "resource");
    assert.equal(built.resource.attributes["deployment.region"], "eu");
    assert.deepEqual(calls, [], "the HMAC was never keyed");
  });
}

test("a policy with no key gives no token in drop and allow mode either", () => {
  calls.length = 0;
  for (const pii of ["drop", "allow"] as const) {
    const policy = SensitivityPolicy.create({ pii, registries: [], hmac: spy });
    assert.equal(policy.token("x"), undefined, pii);
    assert.equal(policy.tokenOf("x"), undefined, pii);
    // The copies the pipelines make hold the same key or lack of one.
    assert.equal(policy.silent().token("x"), undefined, pii);
    assert.equal(policy.withRecorder({ add: () => undefined }).token("x"), undefined, pii);
  }
  assert.deepEqual(calls, []);
});

test("a hash policy with a good key keys the HMAC with a copy of exactly those bytes", () => {
  calls.length = 0;
  const key = new Uint8Array(32).map((_, i) => i + 1);
  const policy = SensitivityPolicy.create({ pii: "hash", key, registries: [], hmac: spy });
  assert.equal(policy.token("x"), reference(key, "x"));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], key);
  assert.notEqual(calls[0], key, "a copy, so the caller cannot change the key afterwards");
  assert.equal(policy.silent().token("x"), reference(key, "x"));
});
