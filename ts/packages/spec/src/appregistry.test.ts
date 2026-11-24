import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  type AppRegistry,
  AppRegistryError,
  AppRegistryViolation,
  compileAppRegistry,
  validateAppRegistry,
} from "./appregistry.ts";
import { AppRegistryParseError, parseAppRegistry } from "./yaml.ts";

// The shared cases every libo11y validator must agree on (conformance/README.md).
const conformanceDir = resolve(import.meta.dirname, "..", "..", "..", "..", "conformance", "appregistry");

// outcome renders what the validator makes of one registry file, in the .want format.
function outcome(text: string): string {
  let reg: AppRegistry;
  try {
    reg = parseAppRegistry(text);
  } catch (err) {
    if (err instanceof AppRegistryParseError) return `parse: ${err.kind}`;
    throw err;
  }
  const result = validateAppRegistry(reg);
  if (result.ok) return `ok ${Object.keys(result.registry.attributes).length} ${result.registry.namespace}`;
  return result.violations.map((v) => v.toString()).join("\n");
}

const files = readdirSync(conformanceDir);
const cases = files.filter((f) => f.endsWith(".yaml")).sort();

test("the conformance directory holds every case", () => {
  assert.ok(cases.length >= 28, `found ${cases.length} cases in ${conformanceDir}, want at least 28`);
});

test("every .want file has a .yaml case", () => {
  for (const want of files.filter((f) => f.endsWith(".want"))) {
    assert.ok(files.includes(want.replace(/\.want$/, ".yaml")), `${want} has no matching .yaml case`);
  }
});

for (const file of cases) {
  const name = file.replace(/\.yaml$/, "");
  test(`conformance: ${name}`, () => {
    const text = readFileSync(join(conformanceDir, file), "utf8");
    const want = readFileSync(join(conformanceDir, `${name}.want`), "utf8").replace(/\n+$/, "");
    assert.equal(outcome(text), want);
  });
}

const attr = { type: "string", sensitivity: "public", cardinality: "bounded" } as const;

test("a valid registry comes back as is", () => {
  const reg: AppRegistry = {
    schema: "libo11y.app-registry/v1",
    namespace: "lor",
    attributes: { "lor.user.id": attr },
  };
  assert.deepEqual(validateAppRegistry(reg), { ok: true, registry: reg });
});

test("attributes are checked in UTF-8 byte order, not UTF-16 order", () => {
  // U+FF61 sorts before U+1F600 in UTF-8 and code point order, after it in UTF-16 code units.
  const reg: AppRegistry = {
    schema: "libo11y.app-registry/v1",
    namespace: "lor",
    attributes: { "lor.\u{1f600}": attr, "lor.｡": attr, "lor.a.b": attr },
  };
  const result = validateAppRegistry(reg);
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.violations.map((v) => v.attribute), ["lor.｡", "lor.\u{1f600}"]);
});

test("a violation renders like Go's Violation.String", () => {
  assert.equal(new AppRegistryViolation("rule_a", undefined, "detail").toString(), "rule_a: detail");
  assert.equal(
    new AppRegistryViolation("rule_b", "lor.a.b", "detail").toString(),
    "rule_b: attribute lor.a.b: detail",
  );
});

test("compileAppRegistry maps each attribute to its sensitivity class", () => {
  const compiled = compileAppRegistry({
    schema: "libo11y.app-registry/v1",
    namespace: "lor",
    attributes: {
      "lor.user.id": { ...attr, sensitivity: "internal" },
      "lor.client.email": { ...attr, sensitivity: "pii" },
    },
  });
  assert.equal(compiled.namespace, "lor");
  assert.equal(compiled.classes["lor.user.id"], "internal");
  assert.equal(compiled.classes["lor.client.email"], "pii");
  assert.equal(
    JSON.stringify(compiled),
    '{"namespace":"lor","classes":{"lor.client.email":"pii","lor.user.id":"internal"}}',
  );
});

test("compileAppRegistry output is frozen and has no prototype to reach", () => {
  const compiled = compileAppRegistry({
    schema: "libo11y.app-registry/v1",
    namespace: "lor",
    attributes: { "lor.user.id": attr },
  });
  assert.equal(Object.getPrototypeOf(compiled.classes), null);
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.classes), true);
  assert.equal(compiled.classes.constructor, undefined);
  assert.equal(compiled.classes.toString, undefined);
});

test("compileAppRegistry throws AppRegistryError with the violations", () => {
  const reg: AppRegistry = { schema: "x", namespace: "http", attributes: {} };
  assert.throws(
    () => compileAppRegistry(reg),
    (err: unknown) => {
      assert.ok(err instanceof AppRegistryError);
      assert.ok(err instanceof Error);
      assert.deepEqual(
        err.violations.map((v) => v.ruleId),
        ["libo11y_app_schema_unknown", "libo11y_app_namespace_reserved", "libo11y_app_attributes_empty"],
      );
      assert.equal(
        err.message,
        'invalid application registry: libo11y_app_schema_unknown: schema "x", want "libo11y.app-registry/v1"; ' +
          'libo11y_app_namespace_reserved: namespace "http" belongs to libo11y, OpenTelemetry, or semconv; ' +
          "libo11y_app_attributes_empty: the registry declares no attributes",
      );
      return true;
    },
  );
});
