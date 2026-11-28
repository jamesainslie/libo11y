/**
 * The boundaries of @libo11y/rum-expo-router: only hook.ts loads React and Expo Router values (the
 * entry reaches them through it), and the route template and the tracker load no package at all,
 * so node tests run them without React Native.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { valueImports } from "../../../scripts/import-graph.ts";

const SRC = import.meta.dirname;

test("only hook.ts reaches react and expo-router; template.ts and tracker.ts reach no package", () => {
  assert.deepEqual([...valueImports(join(SRC, "hook.ts")).packages].sort(), ["expo-router", "react"]);
  assert.deepEqual([...valueImports(join(SRC, "index.ts")).packages].sort(), ["expo-router", "react"]);
  for (const file of ["template.ts", "tracker.ts", "version.ts"]) {
    const { packages, dynamic } = valueImports(join(SRC, file));
    assert.deepEqual([...packages], [], `${file} reaches a package`);
    assert.deepEqual([...dynamic], [], `${file}: a run-time import the graph cannot follow`);
  }
});

test("package.json exports only the root entry, index.ts", () => {
  const manifest = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as {
    exports: Record<string, string>;
  };
  assert.deepEqual(manifest.exports, { ".": "./src/index.ts" });
});
