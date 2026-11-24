import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Core runs in browsers and extensions as well as on servers, so its sources take everything
// runtime-specific from the Platform object. This scan keeps runtime imports and globals out.
const srcDir = import.meta.dirname;

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => join(e.parentPath, e.name));
}

const FORBIDDEN: readonly [RegExp, string][] = [
  [/\bfrom\s+["']node:/, "a node: import"],
  [/\bimport\s*\(\s*["']node:/, "a dynamic node: import"],
  [/\brequire\s*\(/, "a require call"],
  [/\bprocess\./, "process."],
  [/\bBun\./, "Bun."],
  [/\bwindow\./, "window."],
  [/\bdocument\./, "document."],
];

// Comments may name the globals they avoid, so they are blanked before the scan.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

test("core sources use no runtime-specific imports or globals", () => {
  const files = sources(srcDir);
  assert.ok(files.length > 0);
  const problems: string[] = [];
  for (const file of files) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const [pattern, what] of FORBIDDEN) {
      if (pattern.test(text)) problems.push(`${file}: ${what}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the scan catches each forbidden form", () => {
  for (const sample of [
    'import { x } from "node:fs";',
    "const e = process.env;",
    "Bun.serve({});",
    "window.location;",
    "document.title;",
    'await import("node:os");',
  ]) {
    assert.ok(
      FORBIDDEN.some(([p]) => p.test(stripComments(sample))),
      sample,
    );
  }
  assert.ok(!FORBIDDEN.some(([p]) => p.test(stripComments("// process.env is never read"))));
});
