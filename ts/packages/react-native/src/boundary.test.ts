/**
 * The boundaries of @libo11y/react-native: only env.ts loads react-native (index.ts and expo.ts
 * reach it through setupReactNative), only expo.ts loads the Expo modules, nothing reaches a
 * browser-only module or package, and the internal entry evaluates with every browser global
 * removed, as on Hermes, without react-native or Expo.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

/** The Expo modules the ./expo entry imports, optional peer dependencies of the package. */
const EXPO_PACKAGES = new Set(["expo-application", "expo-device", "expo-file-system", "expo-updates"]);

/**
 * The modules that may reach react-native: env.ts imports it, index.ts calls env.ts, expo.ts calls
 * index.ts.
 */
const REACT_NATIVE_MODULES = new Set(["env.ts", "index.ts", "expo.ts"]);

/** Every entry point in package.json, as a source path relative to src. */
const ENTRIES: Readonly<Record<string, string>> = {
  ".": "index.ts",
  "./expo": "expo.ts",
  "./env": "env.ts",
  "./internal": "internal.ts",
};

function sources(dir: string, prefix = ""): string[] {
  return readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${prefix}${e.name}`;
    if (e.isDirectory()) return e.name === "test-support" ? [] : sources(join(dir, e.name), `${rel}/`);
    return rel.endsWith(".ts") && !rel.endsWith(".test.ts") && !rel.endsWith(".d.ts") ? [rel] : [];
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

test("only expo.ts reaches the Expo modules, and it imports each of them", () => {
  for (const file of sources(".")) {
    if (file === "expo.ts") continue;
    const { packages } = valueImports(join(SRC, file));
    for (const p of packages) assert.ok(!p.startsWith("expo"), `${file} reaches ${p}`);
  }
  const { packages } = valueImports(join(SRC, "expo.ts"));
  for (const p of EXPO_PACKAGES) assert.ok(packages.has(p), `expo.ts does not import ${p}`);
});

test("package.json exports exactly the entries the boundaries cover", () => {
  const manifest = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as {
    exports: Record<string, string>;
  };
  assert.deepEqual(
    manifest.exports,
    Object.fromEntries(Object.entries(ENTRIES).map(([k, v]) => [k, `./src/${v}`])),
  );
});

test("the entries import only portable packages and nothing at run time", () => {
  for (const entry of Object.values(ENTRIES)) {
    const { packages, dynamic } = valueImports(join(SRC, entry));
    assert.deepEqual([...dynamic], [], `${entry}: a run-time import the graph cannot follow`);
    for (const p of packages) {
      const allowed = ALLOWED_PACKAGES.has(p) || (entry === "expo.ts" && EXPO_PACKAGES.has(p));
      assert.ok(allowed, `${entry} imports ${p}`);
    }
  }
});

test("the internal entry evaluates and sets up with every browser global removed", () => {
  const script = [
    `for (const k of ${JSON.stringify(BROWSER_GLOBALS)}) Object.defineProperty(globalThis, k, { value: undefined, configurable: true, writable: true });`,
    `const m = await import(${JSON.stringify(pathToFileURL(join(SRC, "internal.ts")).href)});`,
    `const q = await m.openStorageQueue({ storage: m.memoryStorage() });`,
    `const files = new Map();`,
    `const fs = { directoryExists: () => true, createDirectory() {}, fileNames: () => [...files.keys()], file: (n) => ({ get exists() { return files.has(n); }, text: async () => files.get(n), write: async (v) => { files.set(n, v); }, delete: () => files.delete(n) }) };`,
    `await m.expoFileStorageWith(fs).setItem("k", "v");`,
    `const info = m.expoAppInfoFrom({ application: { nativeApplicationVersion: "1.0.0" }, updates: { isEnabled: false, isEmbeddedLaunch: true, updateId: null }, device: { deviceType: 2 } });`,
    `const o = m.withExpoOptions(m.expoOptionsFrom(info, m.memoryStorage()), {});`,
    `if (o.serviceVersion !== "1.0.0" || files.size !== 1) throw new Error("no expo options");`,
    `if (q.kind !== "storage") throw new Error("no storage queue");`,
    `if (!/^[0-9a-f-]{36}$/.test(m.reactNativePlatform({ exportOptions: {}, endpoints: {}, delivery: {}, gate: {}, env: {}, createExporterSet: () => ({}) }).randomUUID())) throw new Error("no UUID");`,
    `console.log("ok");`,
  ].join("\n");
  // Bun runs this file under bun test; the child is always Node, which runs .ts by type stripping.
  const node = process.versions.bun === undefined ? process.execPath : "node";
  const out = execFileSync(node, ["--input-type=module", "-e", script], { cwd: SRC, encoding: "utf8" });
  assert.equal(out.trim(), "ok");
});
