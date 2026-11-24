import assert from "node:assert/strict";
import { test } from "node:test";
import { type AppRegistryParseKind, parseAppRegistry } from "./yaml.ts";

// The expected results below are what Go's appregistry.Parse makes of each input (yaml.v3 with
// KnownFields), checked against the Go implementation when this file was written.

const head = "schema: libo11y.app-registry/v1\nnamespace: lor\n";

// plain drops the null prototypes, so deepEqual compares shapes only.
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function kindOf(text: string): AppRegistryParseKind | "ok" {
  try {
    parseAppRegistry(text);
    return "ok";
  } catch (err) {
    if (err instanceof Error && "kind" in err) return err.kind as AppRegistryParseKind;
    throw err;
  }
}

const zero = { schema: "", namespace: "", attributes: {} };

const parses: readonly (readonly [string, string, unknown])[] = [
  [
    "a full registry",
    `${head}attributes:\n  lor.user.role: {type: string, sensitivity: public, cardinality: enum, values: [a, b], brief: Role.}\n`,
    {
      schema: "libo11y.app-registry/v1",
      namespace: "lor",
      attributes: {
        "lor.user.role": {
          type: "string",
          sensitivity: "public",
          cardinality: "enum",
          values: ["a", "b"],
          brief: "Role.",
        },
      },
    },
  ],
  ["a bare document marker is a zero registry", "---\n", zero],
  ["a comment after a document marker", "# c\n---\n# c\n", zero],
  ["a null document is a zero registry", "~\n", zero],
  ["null fields stay empty", "schema: ~\nnamespace: null\n", zero],
  ["a null key is skipped", "~: x\n", zero],
  [
    "null attributes",
    `${head}attributes: ~\n`,
    { ...zero, schema: "libo11y.app-registry/v1", namespace: "lor" },
  ],
  [
    "a null attribute is a zero attribute",
    `${head}attributes:\n  lor.a.b: ~\n`,
    {
      schema: "libo11y.app-registry/v1",
      namespace: "lor",
      attributes: { "lor.a.b": { type: "", sensitivity: "", cardinality: "" } },
    },
  ],
  [
    "scalars read as their source text and null values are dropped",
    `${head}attributes:\n  lor.a.b: {type: string, values: [1, true, 1.0, ~, "q", 'it''s']}\n`,
    {
      schema: "libo11y.app-registry/v1",
      namespace: "lor",
      attributes: {
        "lor.a.b": {
          type: "string",
          sensitivity: "",
          cardinality: "",
          values: ["1", "true", "1.0", "q", "it's"],
        },
      },
    },
  ],
  [
    "a numeric key reads as text",
    `${head}attributes:\n  1: {type: string}\n`,
    {
      schema: "libo11y.app-registry/v1",
      namespace: "lor",
      attributes: { "1": { type: "string", sensitivity: "", cardinality: "" } },
    },
  ],
  [
    "a block scalar keeps its newline",
    "schema: |\n  v1\nnamespace: lor\n",
    { ...zero, schema: "v1\n", namespace: "lor" },
  ],
  ["a folded plain scalar", "schema: a\n  b\n", { ...zero, schema: "a b" }],
  [
    "explicit tags read as text",
    "schema: !!str 1.0\nnamespace: !!int 1\n",
    { ...zero, schema: "1.0", namespace: "1" },
  ],
  [
    "aliases resolve",
    `schema: &s v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, brief: *s}\n`,
    {
      schema: "v1",
      namespace: "lor",
      attributes: { "lor.a.b": { type: "string", sensitivity: "", cardinality: "", brief: "v1" } },
    },
  ],
  [
    "a merge key fills the fields the mapping does not set",
    `${head}attributes:\n  lor.a.b: &base {type: string, sensitivity: internal, cardinality: unbounded}\n  lor.a.c: {<<: *base, cardinality: bounded}\n`,
    {
      schema: "libo11y.app-registry/v1",
      namespace: "lor",
      attributes: {
        "lor.a.b": { type: "string", sensitivity: "internal", cardinality: "unbounded" },
        "lor.a.c": { type: "string", sensitivity: "internal", cardinality: "bounded" },
      },
    },
  ],
  [
    "the first merged mapping wins",
    `${head}attributes:\n  lor.a.b: {<<: [{type: int, brief: one}, {type: string, sensitivity: pii}], cardinality: bounded}\n`,
    {
      schema: "libo11y.app-registry/v1",
      namespace: "lor",
      attributes: { "lor.a.b": { type: "int", sensitivity: "pii", cardinality: "bounded", brief: "one" } },
    },
  ],
  [
    "merges nest",
    `${head}attributes:\n  lor.a.b: {<<: {<<: {brief: deep}, type: int}, cardinality: bounded}\n`,
    {
      schema: "libo11y.app-registry/v1",
      namespace: "lor",
      attributes: { "lor.a.b": { type: "int", sensitivity: "", cardinality: "bounded", brief: "deep" } },
    },
  ],
  [
    "a merge into the attributes map",
    "attributes:\n  <<: {lor.a.b: {type: string}, lor.a.c: {type: int}}\n  lor.a.b: {type: double}\n",
    {
      ...zero,
      attributes: {
        "lor.a.b": { type: "double", sensitivity: "", cardinality: "" },
        "lor.a.c": { type: "int", sensitivity: "", cardinality: "" },
      },
    },
  ],
];

for (const [name, text, want] of parses) {
  test(`parseAppRegistry: ${name}`, () => {
    assert.deepEqual(plain(parseAppRegistry(text)), want);
  });
}

const failures: readonly (readonly [string, string, AppRegistryParseKind])[] = [
  ["an empty file", "", "empty"],
  ["a comment-only file", "# nothing here\n", "empty"],
  ["a syntax error", "schema: [libo11y\n", "syntax"],
  ["a syntax error before a duplicate key", "a: 1\na: 2\nb: [\n", "syntax"],
  ["a second document", "schema: a\n---\nschema: b\n", "second-document"],
  ["a trailing document marker", "schema: a\n---\n", "second-document"],
  ["a syntax error in the second document", "schema: a\n---\nb: [\n", "syntax"],
  ["a decode error in the first document beats a second document", "colour: red\n---\nx: 1\n", "unknown-key"],
  ["a type error in the first document beats a broken second one", "attributes: [x]\n---\n[\n", "type"],
  [
    "a duplicate key in the first document beats a second document",
    "schema: a\nschema: b\n---\n",
    "duplicate-key",
  ],
  ["a duplicate key", "schema: a\nschema: b\n", "duplicate-key"],
  ["a duplicate key written two ways", 'schema: a\n"schema": b\n', "duplicate-key"],
  ["a duplicate attribute", "attributes:\n  a.b: {}\n  a.b: {}\n", "duplicate-key"],
  ["a duplicate key outranks a type error", "attributes: [x]\nschema: a\nschema: b\n", "duplicate-key"],
  ["an unknown key outranks a later type error", "colour: red\nattributes: [x]\n", "unknown-key"],
  ["an unknown key outranks an earlier type error", "attributes: [x]\ncolour: red\n", "unknown-key"],
  ["an unknown attribute key", `${head}attributes:\n  lor.a.b: {colour: red}\n`, "unknown-key"],
  ["a boolean top-level key", "true: x\n", "unknown-key"],
  ["a sequence document", "- a\n", "type"],
  ["a scalar document", "hello\n", "type"],
  ["a map where a string belongs", "schema: {a: 1}\n", "type"],
  ["a sequence of attributes", `${head}attributes: [lor.a.b]\n`, "type"],
  ["a scalar attribute", `${head}attributes:\n  lor.a.b: x\n`, "type"],
  ["a scalar where values belong", `${head}attributes:\n  lor.a.b: {values: x}\n`, "type"],
  ["a map inside values", `${head}attributes:\n  lor.a.b: {values: [{a: 1}]}\n`, "type"],
  [
    "an unknown key in a merged mapping",
    `${head}attributes:\n  lor.a.b: {<<: {colour: red}, type: string}\n`,
    "unknown-key",
  ],
  ["a merge of a scalar", `${head}attributes:\n  lor.a.b: {<<: x, type: string}\n`, "syntax"],
  [
    "a merge of a sequence holding a scalar",
    `${head}attributes:\n  lor.a.b: {<<: [x], type: string}\n`,
    "syntax",
  ],
  ["a merge of null", `${head}attributes:\n  lor.a.b: {<<: ~, type: string}\n`, "syntax"],
];

for (const [name, text, want] of failures) {
  test(`parseAppRegistry fails: ${name}`, () => {
    assert.equal(kindOf(text), want);
  });
}

test("a parse error is an Error with its kind in the message", () => {
  assert.throws(
    () => parseAppRegistry("schema: a\n---\n"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, "AppRegistryParseError");
      assert.equal((err as Error & { kind: string }).kind, "second-document");
      assert.match(err.message, /second-document/);
      return true;
    },
  );
});

test("attribute names never reach Object.prototype", () => {
  const reg = parseAppRegistry(
    `${head}attributes:\n  __proto__: {type: string}\n  constructor: {type: int}\n`,
  );
  assert.equal(Object.getPrototypeOf(reg.attributes), null);
  assert.deepEqual(Object.keys(reg.attributes).sort(), ["__proto__", "constructor"]);
  assert.equal(Object.getOwnPropertyDescriptor(reg.attributes, "__proto__")?.value?.type, "string");
});
