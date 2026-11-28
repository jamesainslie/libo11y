import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  type AppRegistry,
  AppRegistryError,
  AppRegistryViolation,
  type CompiledAppRegistry,
  compileAppRegistry,
  validateAppRegistry,
  validateCompiledAppRegistry,
} from "./appregistry.ts";
import { AppRegistryParseError, parseAppRegistryBytes } from "./yaml.ts";

// The shared cases every libo11y validator must agree on (conformance/README.md).
const conformanceDir = resolve(import.meta.dirname, "..", "..", "..", "..", "conformance", "appregistry");

// outcome renders what the validator makes of one registry file, in the .want format.
function outcome(bytes: Uint8Array): string {
  let reg: AppRegistry;
  try {
    reg = parseAppRegistryBytes(bytes);
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
  assert.ok(cases.length >= 45, `found ${cases.length} cases in ${conformanceDir}, want at least 45`);
});

test("every .want file has a .yaml case", () => {
  for (const want of files.filter((f) => f.endsWith(".want"))) {
    assert.ok(files.includes(want.replace(/\.want$/, ".yaml")), `${want} has no matching .yaml case`);
  }
});

for (const file of cases) {
  const name = file.replace(/\.yaml$/, "");
  test(`conformance: ${name}`, () => {
    // Bytes, not text: some cases hold invalid UTF-8.
    const bytes = new Uint8Array(readFileSync(join(conformanceDir, file)));
    const want = readFileSync(join(conformanceDir, `${name}.want`), "utf8").replace(/\n+$/, "");
    assert.equal(outcome(bytes), want);
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

// compiledOutcome renders what validateCompiledAppRegistry makes of reg, one violation per line.
function compiledOutcome(reg: unknown): string {
  const result = validateCompiledAppRegistry(reg as CompiledAppRegistry);
  if (result.ok) return `ok ${result.registry.namespace}`;
  return result.violations.map((v) => v.toString()).join("\n");
}

test("validateCompiledAppRegistry accepts what compileAppRegistry returns", () => {
  const compiled = compileAppRegistry({
    schema: "libo11y.app-registry/v1",
    namespace: "lor",
    attributes: { "lor.user.email": { type: "string", sensitivity: "pii", cardinality: "unbounded" } },
  });
  const result = validateCompiledAppRegistry(compiled);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.registry, compiled);
});

test("validateCompiledAppRegistry refuses a reserved or malformed namespace", () => {
  assert.equal(
    compiledOutcome({ namespace: "http", classes: { "http.request.method": "public" } }),
    'libo11y_app_namespace_reserved: namespace "http" belongs to libo11y, OpenTelemetry, or semconv',
  );
  assert.equal(
    compiledOutcome({ namespace: "Lor.x", classes: { "lor.a": "public" } }),
    [
      'libo11y_app_namespace_invalid: namespace "Lor.x" is not one snake_case segment',
      "libo11y_app_attr_outside_namespace: attribute lor.a: not under the Lor.x namespace",
    ].join("\n"),
  );
  assert.equal(
    compiledOutcome({ classes: { "lor.a": "public" } }),
    [
      'libo11y_app_namespace_invalid: namespace "" is not one snake_case segment',
      "libo11y_app_attr_outside_namespace: attribute lor.a: not under the  namespace",
    ].join("\n"),
  );
});

test("validateCompiledAppRegistry refuses keys outside the namespace or badly named", () => {
  assert.equal(
    compiledOutcome({
      namespace: "lor",
      classes: { "user.email": "public", "lor.Bad": "public", "lor.ok": "pii" },
    }),
    [
      "libo11y_attr_naming: attribute lor.Bad: not a dotted snake_case name with at least two segments",
      "libo11y_app_attr_outside_namespace: attribute user.email: not under the lor namespace",
    ].join("\n"),
  );
});

test("validateCompiledAppRegistry refuses an unknown or missing class", () => {
  assert.equal(
    compiledOutcome({ namespace: "lor", classes: { "lor.a": "secretish", "lor.b": "", "lor.c": 3 } }),
    [
      'libo11y_sensitivity_unknown: attribute lor.a: sensitivity "secretish"',
      "libo11y_sensitivity_missing: attribute lor.b: no sensitivity class",
      'libo11y_sensitivity_unknown: attribute lor.c: sensitivity "3"',
    ].join("\n"),
  );
});

test("validateCompiledAppRegistry refuses classes that are not an object, or empty", () => {
  for (const classes of [undefined, null, "public", ["lor.a"], {}]) {
    assert.equal(
      compiledOutcome({ namespace: "lor", classes }),
      "libo11y_app_attributes_empty: the registry declares no attributes",
      `classes ${JSON.stringify(classes)}`,
    );
  }
});
