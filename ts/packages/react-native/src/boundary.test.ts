/**
 * The boundaries of @libo11y/react-native: only env.ts loads react-native (index.ts reaches it
 * through setupReactNative), nothing reaches a browser-only module or package, and the internal
 * entry evaluates with every browser global removed, as on Hermes, without react-native.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { BROWSER_GLOBALS, valueImports } from "../../../scripts/import-graph.ts";

const SRC = import.meta.dirname;

/** The packages the platform imports values from. @libo11y/web's browser entry is not one of them. */
const ALLOWED_PACKAGES = new Set([
  "@libo11y/core",
  "@libo11y/spec",
  "@libo11y/web/portable",
  "@opentelemetry/api",
  "@opentelemetry/core",
  "react-native",
]);

/** The modules that may reach react-native: env.ts imports it, index.ts calls env.ts. */
const REACT_NATIVE_MODULES = new Set(["env.ts", "index.ts"]);

function sources(dir: string, prefix = ""): string[] {
  return readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${prefix}${e.name}`;
    if (e.isDirectory()) return e.name === "test-support" ? [] : sources(join(dir, e.name), `${rel}/`);
    return rel.endsWith(".ts") && !rel.endsWith(".test.ts") ? [rel] : [];
  });
}

test("only env.ts and index.ts reach react-native", () => {
  for (const file of sources(".")) {
    if (REACT_NATIVE_MODULES.has(file)) continue;
    const { packages } = valueImports(join(SRC, file));
    assert.ok(!packages.has("react-native"), `${file} reaches react-native`);
  }
  assert.ok(valueImports(join(SRC, "index.ts")).packages.has("react-native"));
});

test("the entries import only portable packages and nothing at run time", () => {
  for (const entry of ["index.ts", "internal.ts"]) {
    const { packages, dynamic } = valueImports(join(SRC, entry));
    assert.deepEqual([...dynamic], [], `${entry}: a run-time import the graph cannot follow`);
    for (const p of packages) assert.ok(ALLOWED_PACKAGES.has(p), `${entry} imports ${p}`);
  }
});

test("the internal entry evaluates and sets up with every browser global removed", () => {
  const script = [
    `for (const k of ${JSON.stringify(BROWSER_GLOBALS)}) Object.defineProperty(globalThis, k, { value: undefined, configurable: true, writable: true });`,
    `const m = await import(${JSON.stringify(pathToFileURL(join(SRC, "internal.ts")).href)});`,
    `const q = await m.openStorageQueue({ storage: m.memoryStorage() });`,
    `if (q.kind !== "storage") throw new Error("no storage queue");`,
    `if (!/^[0-9a-f-]{36}$/.test(m.reactNativePlatform({ exportOptions: {}, endpoints: {}, delivery: {}, gate: {}, env: {}, createExporterSet: () => ({}) }).randomUUID())) throw new Error("no UUID");`,
    `console.log("ok");`,
  ].join("\n");
  // Bun runs this file under bun test; the child is always Node, which runs .ts by type stripping.
  const node = process.versions.bun === undefined ? process.execPath : "node";
  const out = execFileSync(node, ["--input-type=module", "-e", script], { cwd: SRC, encoding: "utf8" });
  assert.equal(out.trim(), "ok");
});
