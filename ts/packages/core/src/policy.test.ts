import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { AppRegistry, CompiledAppRegistry } from "@libo11y/spec";
import { O11yError } from "./errors.ts";
import { compileRegistries, SensitivityPolicy, type ViolationSink } from "./policy.ts";

const vectors = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "..", "..", "..", "..", "conformance", "vectors", "pii-hash.json"),
    "utf8",
  ),
) as { key_hex: string; cases: { name: string; kind: string; value: unknown; token: string }[] };
const KEY = Uint8Array.from(Buffer.from(vectors.key_hex, "hex"));

class Counts implements ViolationSink {
  readonly seen: string[] = [];
  add(signal: string, rule: string, n: number): void {
    for (let i = 0; i < n; i++) this.seen.push(`${signal}/${rule}`);
  }
}

const lor: CompiledAppRegistry = {
  namespace: "lor",
  classes: { "lor.user.email": "pii", "lor.api.token": "secret", "lor.site.build": "public" },
  source: "lor.yaml",
};

function hashing(): SensitivityPolicy {
  return SensitivityPolicy.create({ pii: "hash", key: KEY, registries: [lor] });
}

test("hash mode needs a key of at least 32 bytes", () => {
  for (const key of [undefined, new Uint8Array(31)]) {
    assert.throws(
      () => SensitivityPolicy.create({ pii: "hash", ...(key ? { key } : {}), registries: [] }),
      (err: unknown) => err instanceof O11yError && err.code === "PII_HASH_KEY",
    );
  }
  SensitivityPolicy.create({ pii: "hash", key: new Uint8Array(32), registries: [] });
  SensitivityPolicy.create({ pii: "drop", registries: [] });
});

test("the token matches every conformance vector", () => {
  const p = hashing();
  for (const c of vectors.cases) {
    const value = c.kind === "bytes" ? new Uint8Array(Buffer.from(c.value as string, "base64")) : c.value;
    assert.equal(p.tokenOf(value), c.token, c.name);
  }
});

test("the spec table wins over a registry, and registries cover the rest", () => {
  const claimsSpecKey: CompiledAppRegistry = { namespace: "host", classes: { "host.ip": "public" } };
  const p = SensitivityPolicy.create({ pii: "drop", registries: [lor, claimsSpecKey] });
  assert.equal(p.classOf("host.ip"), "pii");
  assert.equal(p.classOf("http.request.header.authorization"), "secret");
  assert.equal(p.classOf("lor.user.email"), "pii");
  assert.equal(p.classOf("lor.site.build"), "public");
  assert.equal(p.classOf("lor.unknown"), undefined);
  assert.equal(p.classOf("toString"), undefined);
  assert.equal(p.classOf("__proto__"), undefined);
});

test("two registries with one namespace fail with Go's message", () => {
  const again: CompiledAppRegistry = { namespace: "lor", classes: {} };
  assert.throws(
    () => SensitivityPolicy.create({ pii: "drop", registries: [lor, again] }),
    (err: unknown) =>
      err instanceof O11yError &&
      err.code === "INVALID_APP_REGISTRY" &&
      err.message ===
        'o11y: invalid application registry: lor.yaml and registry 2 both declare namespace "lor"',
  );
});

test("actions follow the PII mode; secrets always drop", () => {
  const modes = [
    ["drop", "drop"],
    ["hash", "rewrite"],
    ["allow", "keep"],
  ] as const;
  for (const [pii, want] of modes) {
    const p = SensitivityPolicy.create({ pii, key: KEY, registries: [lor] });
    assert.equal(p.actionFor("host.ip"), want, pii);
    assert.equal(p.actionFor("lor.api.token"), "drop", pii);
    assert.equal(p.actionFor("service.name"), "keep", pii);
    assert.equal(p.actionFor("unclassified.key"), "keep", pii);
  }
});

test("attributes drops secrets, tokenizes PII and counts each change once", () => {
  const counts = new Counts();
  const p = hashing().withRecorder(counts);
  const out = p.attributes("traces", {
    "http.request.header.authorization": "Bearer x",
    "host.ip": "10.0.0.1",
    "lor.site.build": "b1",
    "lor.user.email": ["a@b.c"],
  });
  assert.deepEqual(out, {
    "host.ip": p.tokenOf("10.0.0.1"),
    "lor.site.build": "b1",
    "lor.user.email": p.tokenOf(["a@b.c"]),
  });
  assert.deepEqual(counts.seen.sort(), [
    "traces/pii_attribute",
    "traces/pii_attribute",
    "traces/secret_attribute",
  ]);
});

test("attributes returns the input when nothing changes, and map values are not walked", () => {
  const counts = new Counts();
  const p = hashing().withRecorder(counts);
  const attrs = { a: 1, nested: { "host.ip": "x" } };
  assert.equal(p.attributes("resource", attrs), attrs);
  assert.deepEqual(counts.seen, []);
});

test("a silent policy decides the same and counts nothing", () => {
  const counts = new Counts();
  const p = hashing().withRecorder(counts).silent();
  assert.deepEqual(p.attributes("traces", { "host.ip": "1", "lor.api.token": "t" }), {
    "host.ip": p.tokenOf("1"),
  });
  assert.deepEqual(counts.seen, []);
});

test("metricAttributes drops PII unless allowed, never rewrites and never counts", () => {
  const counts = new Counts();
  const attrs = { "host.ip": "1", "lor.api.token": "t", route: "/x" };
  assert.deepEqual(hashing().withRecorder(counts).metricAttributes(attrs), { route: "/x" });
  assert.deepEqual(
    SensitivityPolicy.create({ pii: "allow", registries: [lor] })
      .withRecorder(counts)
      .metricAttributes(attrs),
    { "host.ip": "1", route: "/x" },
  );
  assert.deepEqual(counts.seen, []);
  const clean = { route: "/x" };
  assert.equal(hashing().metricAttributes(clean), clean);
});

test("logAttributes judges group members on their dotted keys", () => {
  const counts = new Counts();
  const p = SensitivityPolicy.create({ pii: "drop", registries: [lor] }).withRecorder(counts);
  const out = p.logAttributes({
    host: { ip: "10.0.0.1", name: "h" },
    http: { request: { header: { authorization: "Bearer x" } } },
    lor: { user: { email: "a@b.c" }, site: { build: "b1" } },
    msg: "kept",
  });
  assert.deepEqual(out, { host: { name: "h" }, lor: { site: { build: "b1" } }, msg: "kept" });
  assert.deepEqual(counts.seen.sort(), ["logs/pii_attribute", "logs/pii_attribute", "logs/secret_attribute"]);
});

test("logAttributes tokenizes like the span path, so tokens join across signals", () => {
  const p = hashing();
  const log = p.logAttributes({ host: { ip: "10.0.0.1" } }) as { host: { ip: string } };
  const span = p.attributes("traces", { "host.ip": "10.0.0.1" });
  assert.equal(log.host.ip, span["host.ip"]);
});

test("logAttributes judges a classified key's composite value whole", () => {
  const counts = new Counts();
  const p = hashing().withRecorder(counts);
  const value = { a: "1", b: ["x"] };
  assert.deepEqual(p.logAttributes({ "host.ip": value }), { "host.ip": p.tokenOf(value) });
  assert.deepEqual(p.logAttributes({ "lor.api.token": { a: 1 } }), {});
  assert.deepEqual(counts.seen.sort(), ["logs/pii_attribute", "logs/secret_attribute"]);
});

test("logAttributes walks arrays of groups on the holder's key", () => {
  const p = SensitivityPolicy.create({ pii: "drop", registries: [] });
  const out = p.logAttributes({ host: [{ ip: "1", name: "a" }, { ip: "2" }, "plain"] });
  assert.deepEqual(out, { host: [{ name: "a" }, "plain"] });
});

test("logAttributes returns the input when nothing changes", () => {
  const p = hashing();
  const attrs = { a: { b: [1, { c: "d" }], e: new Uint8Array([1]) }, err: new Error("x") };
  assert.equal(p.logAttributes(attrs), attrs);
});

test("logAttributes fails closed past the depth bound", () => {
  const p = SensitivityPolicy.create({ pii: "drop", registries: [] });
  let deep: Record<string, unknown> = { leaf: "x" };
  for (let i = 0; i < 16; i++) deep = { n: deep };
  const out = p.logAttributes({ ok: "1", deep: deep as never });
  assert.deepEqual(out, { ok: "1" });
  let shallow: Record<string, unknown> = { leaf: "x" };
  for (let i = 0; i < 10; i++) shallow = { n: shallow };
  assert.deepEqual(p.logAttributes({ shallow: shallow as never }), { shallow });
});

test("logAttributes cuts cycles and drops what is left past the node budget", () => {
  const p = SensitivityPolicy.create({ pii: "drop", registries: [] });
  const cyclic: Record<string, unknown> = { a: "1" };
  cyclic.self = cyclic;
  assert.deepEqual(p.logAttributes({ c: cyclic as never }), { c: { a: "1" } });

  const wide: Record<string, string> = {};
  for (let i = 0; i < 3000; i++) wide[`k${String(i).padStart(4, "0")}`] = "v";
  const out = p.logAttributes({ wide }) as { wide: Record<string, string> };
  const kept = Object.keys(out.wide).length;
  assert.ok(kept > 0 && kept < 3000, `kept ${kept}`);
  assert.equal(out.wide.k0000, "v");
});

test("logAttributes drops a group classification empties", () => {
  const p = SensitivityPolicy.create({ pii: "drop", registries: [] });
  assert.deepEqual(p.logAttributes({ host: { ip: "1" }, a: "b" }), { a: "b" });
});

test("compileRegistries validates plain registries and keeps compiled ones", () => {
  const plain: AppRegistry = {
    schema: "libo11y.app-registry/v1",
    namespace: "shop",
    attributes: { "shop.order.id": { type: "string", sensitivity: "internal", cardinality: "unbounded" } },
  };
  const out = compileRegistries([plain, lor]);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.namespace, "shop");
  assert.equal(out[0]?.classes["shop.order.id"], "internal");
  assert.equal(out[1], lor);
  assert.deepEqual(compileRegistries(undefined), []);
  assert.deepEqual(compileRegistries(lor), [lor]);
});

test("an invalid registry fails with Go's message, naming it by position", () => {
  const bad: AppRegistry = { schema: "libo11y.app-registry/v1", namespace: "shop", attributes: {} };
  assert.throws(
    () => compileRegistries([lor, bad]),
    (err: unknown) =>
      err instanceof O11yError &&
      err.code === "INVALID_APP_REGISTRY" &&
      err.message ===
        "o11y: invalid application registry: registry 2: libo11y_app_attributes_empty: the registry declares no attributes",
  );
});

test("a platform hmac replaces the built-in one", () => {
  const calls: number[] = [];
  const p = SensitivityPolicy.create({
    pii: "hash",
    key: KEY,
    registries: [],
    hmac: (_k, d) => {
      calls.push(d.length);
      return new Uint8Array(32).fill(0xab);
    },
  });
  assert.equal(p.tokenOf("abc"), `hmac-sha256:${"ab".repeat(16)}`);
  assert.deepEqual(calls, [3]);
});

test("the key is copied, so later changes to the caller's buffer do not change tokens", () => {
  const key = new Uint8Array(KEY);
  const p = SensitivityPolicy.create({ pii: "hash", key, registries: [] });
  const before = p.tokenOf("x");
  key.fill(0);
  assert.equal(p.tokenOf("x"), before);
});

test("logAttributes keeps each group's own member order", () => {
  const p = SensitivityPolicy.create({ pii: "drop", registries: [] });
  const out = p.logAttributes({ host: { z: "1", ip: "x", a: "2" } }) as { host: Record<string, string> };
  assert.deepEqual(Object.keys(out.host), ["z", "a"]);
});
