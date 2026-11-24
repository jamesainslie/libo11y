import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { run } from "./cli.ts";

const files: Readonly<Record<string, string>> = {
  "valid.yaml":
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.user.id: {type: string, sensitivity: internal, cardinality: unbounded}\n",
  "two.yaml":
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.user.id: {type: string, sensitivity: internal, cardinality: unbounded}\n  lor.user.role: {type: string, sensitivity: public, cardinality: bounded}\n",
  "invalid.yaml":
    "schema: libo11y.app-registry/v1\nnamespace: http\nattributes:\n  http.thing: {type: string, sensitivity: public, cardinality: bounded}\n",
  "broken.yaml": "schema: [\n",
};

function readFile(path: string): string {
  const body = files[path];
  if (body === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  return body;
}

function check(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = run(
    args,
    (s) => {
      stdout += `${s}\n`;
    },
    (s) => {
      stderr += `${s}\n`;
    },
    readFile,
  );
  return { code, stdout, stderr };
}

// The table from go/cmd/libo11y/main_test.go: an empty want means the stream must be empty, any other
// want must appear in it.
const table: readonly (readonly [string, readonly string[], number, string, string])[] = [
  ["valid", ["registry", "check", "valid.yaml"], 0, "ok (1 attribute in namespace lor)", ""],
  ["violations", ["registry", "check", "invalid.yaml"], 1, "libo11y_app_namespace_reserved", ""],
  ["unparsable", ["registry", "check", "broken.yaml"], 2, "", "parsing application registry"],
  ["missing", ["registry", "check", "nope.yaml"], 2, "", "no such file"],
  [
    "worst wins",
    ["registry", "check", "invalid.yaml", "broken.yaml"],
    2,
    "libo11y_app_namespace_reserved",
    "parsing",
  ],
  ["no files", ["registry", "check"], 2, "", "usage:"],
  ["unknown", ["lint"], 2, "", "usage:"],
  ["help", ["-h"], 0, "usage:", ""],
  ["long help", ["--help"], 0, "usage:", ""],
  ["help word", ["help"], 0, "usage:", ""],
];

function assertStream(name: string, got: string, want: string): void {
  if (want === "") {
    assert.equal(got, "", `${name} should be empty`);
  } else {
    assert.ok(got.includes(want), `${name} ${JSON.stringify(got)} lacks ${JSON.stringify(want)}`);
  }
}

for (const [name, args, wantCode, wantStdout, wantStderr] of table) {
  test(`registry check: ${name}`, () => {
    const got = check(args);
    assert.equal(got.code, wantCode, `exit ${got.code} (stdout ${got.stdout}, stderr ${got.stderr})`);
    assertStream("stdout", got.stdout, wantStdout);
    assertStream("stderr", got.stderr, wantStderr);
  });
}

test("registry check prints the same lines as the Go binary", () => {
  assert.deepEqual(
    check(["registry", "check", "valid.yaml", "two.yaml", "invalid.yaml", "nope.yaml", "broken.yaml"]),
    {
      code: 2,
      stdout:
        "valid.yaml: ok (1 attribute in namespace lor)\n" +
        "two.yaml: ok (2 attributes in namespace lor)\n" +
        'invalid.yaml: libo11y_app_namespace_reserved: namespace "http" belongs to libo11y, OpenTelemetry, or semconv\n',
      stderr: `nope.yaml: ENOENT: no such file or directory, open 'nope.yaml'\n${check(["registry", "check", "broken.yaml"]).stderr}`,
    },
  );
  assert.match(
    check(["registry", "check", "broken.yaml"]).stderr,
    /^broken\.yaml: parsing application registry: syntax/,
  );
  assert.equal(check(["-h"]).stdout, "usage: libo11y registry check FILE...\n");
});

test("the bin runs under the current runtime", () => {
  const conformance = resolve(import.meta.dirname, "..", "..", "..", "..", "conformance", "appregistry");
  const valid = resolve(conformance, "valid.yaml");
  const multi = resolve(conformance, "multi.yaml");
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "cli.ts"), "registry", "check", valid, multi],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    `${valid}: ok (5 attributes in namespace lor)\n` +
      `${multi}: libo11y_app_schema_unknown: schema "x", want "libo11y.app-registry/v1"\n` +
      `${multi}: libo11y_sensitivity_missing: attribute lor.a.first: no sensitivity class\n` +
      `${multi}: libo11y_cardinality_missing: attribute lor.a.first: no cardinality budget\n` +
      `${multi}: libo11y_app_type_unknown: attribute lor.z.last: type "str"\n` +
      `${multi}: libo11y_app_enum_values_missing: attribute lor.z.last: an enum declares its values\n` +
      `${multi}: libo11y_app_attr_outside_namespace: attribute other.key: not under the lor namespace\n`,
  );
});
