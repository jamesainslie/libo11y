/**
 * The boundary of @libo11y/web/portable: nothing reachable from it is browser-only, and it
 * evaluates on a runtime with no browser global, as React Native on Hermes.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { BROWSER_GLOBALS, valueImports } from "../../../scripts/import-graph.ts";

const SRC = import.meta.dirname;
const ENTRY = join(SRC, "portable.ts");

/** Browser-only modules: none may be reachable, because Metro would bundle them into every app. */
const DENIED = [
  "index.ts",
  "internal/index.ts",
  "setup.ts",
  "platform.ts",
  "resource.ts",
  "lifecycle.ts",
  "queue/indexeddb.ts",
  "queue/open.ts",
  "instrumentation/document-load.ts",
];

/**
 * The packages portable modules import directly. @libo11y/core is a platform-neutral package of its
 * own (it brings @opentelemetry/resources), so the graph stops there.
 */
const ALLOWED_PACKAGES = new Set([
  "@libo11y/core",
  "@opentelemetry/api",
  "@opentelemetry/core",
  "@opentelemetry/otlp-transformer",
  "@opentelemetry/sdk-logs",
  "@opentelemetry/sdk-metrics",
  "@opentelemetry/sdk-trace",
]);

test("the portable entry reaches no browser-only module and no browser-only package", () => {
  const { files, packages, dynamic } = valueImports(ENTRY);
  assert.deepEqual([...dynamic], [], "a run-time import the graph cannot follow");
  const rel = [...files].map((f) => f.slice(SRC.length + 1));
  for (const denied of DENIED) assert.ok(!rel.includes(denied), `portable reaches ${denied}`);
  for (const p of packages) assert.ok(ALLOWED_PACKAGES.has(p), `portable imports ${p}`);
});

test("the portable entry evaluates and makes IDs with every browser global removed", () => {
  const script = [
    `for (const k of ${JSON.stringify(BROWSER_GLOBALS)}) Object.defineProperty(globalThis, k, { value: undefined, configurable: true, writable: true });`,
    `const m = await import(${JSON.stringify(pathToFileURL(ENTRY).href)});`,
    `if (typeof m.createDelivery !== "function") throw new Error("no createDelivery");`,
    `if (!/^[0-9a-f-]{36}$/.test(m.randomUuid())) throw new Error("no UUID");`,
    `const c = m.createConsentController({ initial: "granted" });`,
    `if (m.parseResourceAttributes("a=1").a !== "1") throw new Error("no parseResourceAttributes");`,
    `if (typeof m.instrumentFetchWith !== "function" || typeof m.installXhrInstrumentationWith !== "function") throw new Error("no HTTP internals");`,
    `if (!c.recording()) throw new Error("consent does not grant");`,
    `console.log("ok");`,
  ].join("\n");
  // Bun runs this file under bun test; the child is always Node, which runs .ts by type stripping.
  const node = process.versions.bun === undefined ? process.execPath : "node";
  const out = execFileSync(node, ["--input-type=module", "-e", script], { cwd: SRC, encoding: "utf8" });
  assert.equal(out.trim(), "ok");
});
