import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { O11yError } from "@libo11y/core";
import { loadAppRegistry } from "./registry.ts";

const FIXTURES = fileURLToPath(new URL("../../../../conformance/appregistry/", import.meta.url));
const fixture = (name: string): string => join(FIXTURES, `${name}.yaml`);

async function rejection(path: string): Promise<O11yError> {
  try {
    await loadAppRegistry(path);
  } catch (err) {
    assert.ok(err instanceof O11yError, String(err));
    assert.equal(err.code, "INVALID_APP_REGISTRY");
    return err;
  }
  assert.fail(`${path} loaded`);
}

test("a valid registry compiles with its path as the source", async () => {
  const path = fixture("valid");
  const reg = await loadAppRegistry(path);
  assert.equal(reg.namespace, "lor");
  assert.equal(reg.source, path);
  assert.deepEqual(
    { ...reg.classes },
    {
      "lor.user.id": "internal",
      "lor.user.role": "public",
      "lor.project.id": "internal",
      "lor.client.email": "pii",
      "lor.retry.count": "public",
    },
  );
});

test("a missing file fails as Go's os.ReadFile does", async () => {
  const path = join(tmpdir(), "libo11y-no-such-registry.yaml");
  const err = await rejection(path);
  assert.equal(err.message, `o11y: reading application registry: open ${path}: no such file or directory`);
});

test("a directory fails as Go's read does", async () => {
  const dir = mkdtempSync(join(tmpdir(), "libo11y-registry-"));
  try {
    const err = await rejection(dir);
    assert.equal(err.message, `o11y: reading application registry: read ${dir}: is a directory`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("violations are joined in Go's message format", async () => {
  const path = fixture("multi");
  const err = await rejection(path);
  assert.equal(
    err.message,
    `o11y: invalid application registry: ${path}: ` +
      [
        'libo11y_app_schema_unknown: schema "x", want "libo11y.app-registry/v1"',
        "libo11y_sensitivity_missing: attribute lor.a.first: no sensitivity class",
        "libo11y_cardinality_missing: attribute lor.a.first: no cardinality budget",
        'libo11y_app_type_unknown: attribute lor.z.last: type "str"',
        "libo11y_app_enum_values_missing: attribute lor.z.last: an enum declares its values",
        "libo11y_app_attr_outside_namespace: attribute other.key: not under the lor namespace",
      ].join("; "),
  );
});

test("an empty file and a second document read as Go's sentinel errors", async () => {
  const empty = fixture("empty");
  assert.equal((await rejection(empty)).message, `o11y: ${empty}: application registry is empty`);
  const second = fixture("second-document");
  assert.equal(
    (await rejection(second)).message,
    `o11y: ${second}: parsing application registry: an application registry holds one YAML document, found a second`,
  );
});

test("other parse failures name the parse class", async () => {
  const path = fixture("unknown-key");
  const err = await rejection(path);
  assert.match(
    err.message,
    new RegExp(
      `^o11y: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: parsing application registry: unknown-key: `,
    ),
  );
  const dir = mkdtempSync(join(tmpdir(), "libo11y-registry-"));
  try {
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "schema: [\n");
    assert.match(
      (await rejection(bad)).message,
      /^o11y: .*bad\.yaml: parsing application registry: syntax: /,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
