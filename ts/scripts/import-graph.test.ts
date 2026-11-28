import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { valueImports } from "./import-graph.ts";

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "import-graph-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function relative(dir: string, files: ReadonlySet<string>): string[] {
  return [...files].map((f) => f.slice(dir.length + 1)).sort();
}

test("follows value imports and re-exports, skips type-only ones", () => {
  const dir = tree({
    "entry.ts": [
      'import { a } from "./a.ts";',
      'import type { T } from "./types.ts";',
      'export type { U } from "./types2.ts";',
      'export { b } from "./b.ts";',
      'import { type V, w } from "@scope/pkg/sub";',
      "export const x = a;",
    ].join("\n"),
    "a.ts": 'import "./side.ts";\nexport const a = 1;',
    "b.ts": 'import { diag } from "@opentelemetry/api";\nexport const b = diag;',
    "side.ts": "export {};",
    "types.ts": 'import { never } from "./never.ts";\nexport type T = typeof never;',
    "types2.ts": "export type U = 1;",
    "never.ts": "export const never = 0;",
  });
  const { files, packages } = valueImports(join(dir, "entry.ts"));
  assert.deepEqual(relative(dir, files), ["a.ts", "b.ts", "entry.ts", "side.ts"]);
  assert.deepEqual([...packages].sort(), ["@opentelemetry/api", "@scope/pkg/sub"]);
});

test("reads multi-line import lists and namespace and default imports", () => {
  const dir = tree({
    "entry.ts": [
      "import {",
      "  a,",
      "  type B,",
      '} from "./a.ts";',
      'import * as ns from "./ns.ts";',
      'import def, { c } from "./def.ts";',
      'export * from "./star.ts";',
      "export const x = [a, ns, def, c];",
    ].join("\n"),
    "a.ts": "export const a = 1; export type B = 2;",
    "ns.ts": "export const n = 1;",
    "def.ts": "export default 1; export const c = 2;",
    "star.ts": "export const s = 1;",
  });
  assert.deepEqual(relative(dir, valueImports(join(dir, "entry.ts")).files), [
    "a.ts",
    "def.ts",
    "entry.ts",
    "ns.ts",
    "star.ts",
  ]);
});

test("a declaration before a type-only re-export does not make it a value import", () => {
  const dir = tree({
    "entry.ts": ["export const x = 1;", 'export type { U } from "./types.ts";'].join("\n"),
    "types.ts": "export type U = 1;",
  });
  assert.deepEqual(relative(dir, valueImports(join(dir, "entry.ts")).files), ["entry.ts"]);
});

test("ignores import statements in comments and strings that are not at a line start", () => {
  const dir = tree({
    "entry.ts": [
      "/**",
      ' * import { a } from "./a.ts";',
      " */",
      "const s = 'import { b } from \"./b.ts\"';",
      "export { s };",
    ].join("\n"),
  });
  const { files, packages } = valueImports(join(dir, "entry.ts"));
  assert.deepEqual(relative(dir, files), ["entry.ts"]);
  assert.equal(packages.size, 0);
});

test("follows subdirectories and parent paths", () => {
  const dir = tree({
    "src/entry.ts": 'export { a } from "./sub/a.ts";',
    "src/sub/a.ts": 'import { b } from "../b.ts";\nexport const a = b;',
    "src/b.ts": "export const b = 1;",
  });
  assert.deepEqual(relative(dir, valueImports(join(dir, "src/entry.ts")).files), [
    "src/b.ts",
    "src/entry.ts",
    "src/sub/a.ts",
  ]);
});
