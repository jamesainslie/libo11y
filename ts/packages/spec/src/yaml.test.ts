import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAppRegistry } from "./appregistry.ts";
import { type AppRegistryParseKind, parseAppRegistry, parseAppRegistryBytes } from "./yaml.ts";

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

// Generated once from Go's appregistry.Parse and Validate over the same inputs.
const matchesGo: readonly (readonly [string, string, string])[] = [
  [
    "a self-referential merge",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: &a {<<: *a}\n",
    "parse: syntax",
  ],
  [
    "an alias to an anchor defined later",
    "schema: libo11y.app-registry/v1\nnamespace: lor\na: *x\nb: &x 1\n",
    "parse: syntax",
  ],
  [
    "an unknown alias in a value nothing decodes",
    "schema: libo11y.app-registry/v1\nnamespace: lor\ncolour: *nope\n",
    "parse: syntax",
  ],
  [
    "an alias to a sequence that holds itself",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: &v [a, *v]}\n",
    "parse: type",
  ],
  [
    "a raw control character",
    'schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, "b\u0007"]}\n',
    "parse: syntax",
  ],
  [
    "a raw DEL",
    'schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, "b\u007f"]}\n',
    "parse: syntax",
  ],
  [
    "a raw U+FFFE",
    'schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, "b\ufffe"]}\n',
    "parse: syntax",
  ],
  [
    "a byte order mark inside a value",
    'schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, "b\ufeffc"]}\n',
    "ok 1 lor",
  ],
  ["a lone document end marker", "...\n", "parse: syntax"],
  [
    "content after a document end marker",
    "schema: libo11y.app-registry/v1\nnamespace: lor\n...\nx: 1\n",
    "parse: syntax",
  ],
  [
    "a document marker after an end marker",
    "schema: libo11y.app-registry/v1\nnamespace: lor\n...\n---\n",
    "parse: second-document",
  ],
  [
    "a comment after an end marker",
    "schema: libo11y.app-registry/v1\nnamespace: lor\n...\n# trailing\n",
    "libo11y_app_attributes_empty: the registry declares no attributes",
  ],
  [
    "a YAML 1.1 directive",
    "%YAML 1.1\n---\nschema: libo11y.app-registry/v1\nnamespace: lor\n",
    "libo11y_app_attributes_empty: the registry declares no attributes",
  ],
  [
    "a YAML 1.1 directive with a merge",
    "%YAML 1.1\n---\nschema: libo11y.app-registry/v1\nnamespace: lor\nattributes: {lor.a.b: {<<: {type: string}, sensitivity: public, cardinality: bounded}}\n",
    "ok 1 lor",
  ],
  [
    "!!bool yes",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, !!bool yes]}\n",
    "parse: syntax",
  ],
  [
    "!!int with a hex value and a quoted value",
    'schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, !!int 0x1F, !!int "12", !!int 1_000, !!int 0o17, !!int -0b11]}\n',
    "ok 1 lor",
  ],
  [
    "!!int out of range",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, !!int 99999999999999999999999]}\n",
    "parse: syntax",
  ],
  [
    "!!float with ints and floats",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, !!float 12, !!float .5, !!float 1e3, !!float .inf, !!float -.NaN, !!float 1_0.5]}\n",
    "parse: syntax",
  ],
  [
    "!!float overflow",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, !!float 1e400]}\n",
    "parse: syntax",
  ],
  [
    "!!null with an empty value",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, !!null ]}\n",
    "ok 1 lor",
  ],
  [
    "!!timestamp with a bad month",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, !!timestamp 2001-13-01]}\n",
    "parse: syntax",
  ],
  [
    "!!timestamp with a date and time",
    'schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, !!timestamp 2001-12-14, !!timestamp "2001-12-14t21:59:43.10-05:00", !!timestamp 2001-2-3 4:05:06]}\n',
    "ok 1 lor",
  ],
  [
    "!!timestamp on February 30",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, !!timestamp 2001-02-30]}\n",
    "parse: syntax",
  ],
  [
    "!!binary with bad padding",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, !!binary aGVsbG8]}\n",
    "parse: syntax",
  ],
  [
    "!!binary in a block scalar",
    'schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, !!binary "aGVs\\nbG8="]}\n',
    "ok 1 lor",
  ],
  [
    "a custom tag reads as text",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, !foo bar]}\n",
    "ok 1 lor",
  ],
  [
    "a tag in a value nothing decodes",
    "schema: libo11y.app-registry/v1\nnamespace: lor\ncolour: !!int abc\n",
    "parse: unknown-key",
  ],
  [
    "a bad tag on a key",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  !!int abc: {type: string}\n",
    "parse: syntax",
  ],
  [
    "a bad tag on an attributes scalar",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes: !!int abc\n",
    "parse: syntax",
  ],
  [
    "every escape yaml.v3 accepts",
    'schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, "\\x41\\u00e9\\U0001F600\\N\\_\\L\\P\\e\\0\\ \\t\\\'\\"\\\\\\a\\b\\v\\f\\r\\n"]}\n',
    'libo11y_enum_value_whitespace: attribute lor.a.b: value "A\u00e9\ud83d\ude00\\u0085\\u00a0\\u2028\\u2029\\x1b\\x00 \\t\'\\"\\\\\\a\\b\\v\\f\\r\\n"',
  ],
  [
    "an escape in a value nothing decodes",
    'schema: libo11y.app-registry/v1\nnamespace: lor\ncolour: "\\/"\n',
    "parse: syntax",
  ],
  [
    "an escape in a key",
    'schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  "lor.\\/": {type: string}\n',
    "parse: syntax",
  ],
  [
    "an escape above U+10FFFF",
    'schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, "\\U00110000"]}\n',
    "parse: syntax",
  ],
  [
    "a short hex escape",
    'schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, "\\x4"]}\n',
    "parse: syntax",
  ],
  [
    "an escaped line break",
    'schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a, "b\\\n     c"]}\n',
    "ok 1 lor",
  ],
  [
    "an alias to a << scalar is a plain key",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: bounded, brief: &m <<}\n  *m : {type: string}\n",
    "libo11y_app_attr_outside_namespace: attribute <<: not under the lor namespace\nlibo11y_attr_naming: attribute <<: not a dotted snake_case name with at least two segments\nlibo11y_sensitivity_missing: attribute <<: no sensitivity class\nlibo11y_cardinality_missing: attribute <<: no cardinality budget",
  ],
  [
    "a %TAG directive",
    "%TAG !e! tag:example.com,2000:\n---\nschema: libo11y.app-registry/v1\nnamespace: lor\nattributes: {lor.a.b: {type: !e!foo string, sensitivity: public, cardinality: bounded}}\n",
    "ok 1 lor",
  ],
  [
    "a duplicate %YAML directive",
    "%YAML 1.1\n%YAML 1.1\n---\nschema: libo11y.app-registry/v1\nnamespace: lor\n",
    "parse: syntax",
  ],
  [
    "a !!map tag on a merged mapping",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {<<: !!map {type: string}, sensitivity: public, cardinality: bounded}\n",
    "ok 1 lor",
  ],
  [
    "a merged key that resolves to an int is not shadowed by text",
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: bounded}\n  <<: {1: {type: int}}\n  1: {type: int}\n",
    "libo11y_app_attr_outside_namespace: attribute 1: not under the lor namespace\nlibo11y_attr_naming: attribute 1: not a dotted snake_case name with at least two segments\nlibo11y_sensitivity_missing: attribute 1: no sensitivity class\nlibo11y_cardinality_missing: attribute 1: no cardinality budget",
  ],
];

// outcome renders a parse and validation in the conformance .want format.
function outcome(parse: () => ReturnType<typeof parseAppRegistry>): string {
  let reg: ReturnType<typeof parseAppRegistry>;
  try {
    reg = parse();
  } catch (err) {
    if (err instanceof Error && "kind" in err) return `parse: ${String(err.kind)}`;
    throw err;
  }
  const result = validateAppRegistry(reg);
  if (result.ok) return `ok ${Object.keys(reg.attributes).length} ${reg.namespace}`;
  return result.violations.map((v) => v.toString()).join("\n");
}

for (const [name, text, want] of matchesGo) {
  test(`parseAppRegistry matches Go: ${name}`, () => {
    assert.equal(
      outcome(() => parseAppRegistry(text)),
      want,
    );
  });
}

const registry = `${head}attributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: bounded}\n`;

function utf16(text: string, littleEndian: boolean, bom = true): Uint8Array {
  const bytes = new Uint8Array((text.length + (bom ? 1 : 0)) * 2);
  const view = new DataView(bytes.buffer);
  let at = 0;
  if (bom) {
    view.setUint16(0, 0xfeff, littleEndian);
    at = 2;
  }
  for (let i = 0; i < text.length; i++) view.setUint16(at + i * 2, text.charCodeAt(i), littleEndian);
  return bytes;
}

const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));

const byteCases: readonly (readonly [string, Uint8Array, string])[] = [
  ["UTF-8", utf8(registry), "ok 1 lor"],
  ["UTF-8 with a byte order mark", new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(registry)]), "ok 1 lor"],
  ["UTF-16LE after a byte order mark", utf16(registry, true), "ok 1 lor"],
  ["UTF-16BE after a byte order mark", utf16(registry, false), "ok 1 lor"],
  ["UTF-16 without a byte order mark", utf16(registry, true, false), "parse: syntax"],
  ["UTF-16 with an odd byte count", new Uint8Array([...utf16(registry, true), 0x61]), "parse: syntax"],
  ["invalid UTF-8", new Uint8Array([...utf8(registry), 0x23, 0xff, 0x0a]), "parse: syntax"],
];

for (const [name, bytes, want] of byteCases) {
  test(`parseAppRegistryBytes: ${name}`, () => {
    assert.equal(
      outcome(() => parseAppRegistryBytes(bytes)),
      want,
    );
  });
}

test("text yaml.v3 could never read is a syntax error", () => {
  assert.equal(kindOf(`${registry}# \u0000\n`), "syntax");
  assert.equal(kindOf(`${registry}# \ud800\n`), "syntax");
});

test("an alias bomb stops at yaml.v3's alias budget", () => {
  const lines = [
    `${head}attributes:`,
    "  lor.a0: &a0 {type: int, sensitivity: public, cardinality: bounded}",
  ];
  for (let n = 1; n <= 9; n++) {
    lines.push(`  lor.a${n}: &a${n} {<<: [${Array.from({ length: 10 }, () => `*a${n - 1}`).join(", ")}]}`);
  }
  const start = performance.now();
  assert.equal(kindOf(`${lines.join("\n")}\n`), "syntax");
  assert.ok(performance.now() - start < 2000, "the budget stops the expansion early");
});

test("nesting the parser accepts costs linear time", () => {
  const start = performance.now();
  assert.equal(kindOf(`attributes: ${"[".repeat(500)}${"]".repeat(500)}\n`), "type");
  assert.ok(performance.now() - start < 2000);
});
