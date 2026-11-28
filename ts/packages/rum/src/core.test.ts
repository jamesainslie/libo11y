/**
 * The boundary of @libo11y/rum/core: nothing reachable from it is browser-only, it imports only
 * portable packages, and it evaluates on a runtime with no browser global, as React Native on Hermes.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { BROWSER_GLOBALS, valueImports } from "../../../scripts/import-graph.ts";

const SRC = import.meta.dirname;
const ENTRY = join(SRC, "core.ts");

/** Browser-only RUM modules: the web wiring, the page's stores and the DOM collectors. */
const DENIED_FILES = [
  "index.ts",
  "internal.ts",
  "webext.ts",
  "bootstrap.ts",
  "setup.ts",
  "bind.ts",
  "loaf.ts",
  "session/local-store.ts",
  "actions/collector.ts",
  "actions/naming.ts",
  "errors/collector.ts",
  // The web's views collector and its History API watcher. A later milestone that admits them
  // takes them off this list on purpose.
  "views/collector.ts",
  "views/history.ts",
];
const DENIED_DIRS = ["vitals/", "resources/", "bootstrap/", "webext/"];

/** The packages the core may import values from. */
const ALLOWED_PACKAGES = new Set([
  "@libo11y/core",
  "@libo11y/spec",
  "@libo11y/web/portable",
  "@opentelemetry/api",
  "@opentelemetry/core",
  "@opentelemetry/sdk-logs",
  "@opentelemetry/sdk-trace",
]);

test("@libo11y/rum/core reaches no browser-only module and imports nothing at run time", () => {
  const { files, dynamic } = valueImports(ENTRY);
  assert.deepEqual([...dynamic], [], "a run-time import the graph cannot follow");
  const rel = [...files].map((f) => f.slice(SRC.length + 1));
  for (const f of DENIED_FILES) assert.ok(!rel.includes(f), `core reaches ${f}`);
  for (const d of DENIED_DIRS) assert.ok(!rel.some((f) => f.startsWith(d)), `core reaches ${d}`);
});

test("@libo11y/rum/core imports only portable packages", () => {
  for (const p of valueImports(ENTRY).packages) assert.ok(ALLOWED_PACKAGES.has(p), `core imports ${p}`);
});

test("@libo11y/rum/core evaluates and makes IDs with every browser global removed", () => {
  const script = [
    `for (const k of ${JSON.stringify(BROWSER_GLOBALS)}) Object.defineProperty(globalThis, k, { value: undefined, configurable: true, writable: true });`,
    `const m = await import(${JSON.stringify(pathToFileURL(ENTRY).href)});`,
    `if (typeof m.setupRumCore !== "function") throw new Error("no setupRumCore");`,
    `if (!/^[0-9a-f-]{36}$/.test(m.randomUuid())) throw new Error("no UUID");`,
    `console.log("ok");`,
  ].join("\n");
  // Bun runs this file under bun test; the child is always Node, which runs .ts by type stripping.
  const node = process.versions.bun === undefined ? process.execPath : "node";
  const out = execFileSync(node, ["--input-type=module", "-e", script], { cwd: SRC, encoding: "utf8" });
  assert.equal(out.trim(), "ok");
});

test("setupRumCore runs a session, an action and a hide with every browser global removed", () => {
  const bare = pathToFileURL(join(SRC, "test-support", "bare-core.ts")).href;
  const script = [
    `for (const k of ${JSON.stringify(BROWSER_GLOBALS)}) Object.defineProperty(globalThis, k, { value: undefined, configurable: true, writable: true });`,
    `const { runBareCore } = await import(${JSON.stringify(bare)});`,
    "console.log(JSON.stringify(await runBareCore()));",
  ].join("\n");
  const node = process.versions.bun === undefined ? process.execPath : "node";
  const out = execFileSync(node, ["--input-type=module", "-e", script], { cwd: SRC, encoding: "utf8" });
  const run = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as {
    sessionId?: string;
    events: string[];
    spans: string[];
    unsubscribed: boolean;
  };
  assert.match(run.sessionId ?? "", /^[0-9a-f-]{36}$/);
  assert.ok(run.spans.includes("action custom"), `spans: ${run.spans.join(", ")}`);
  assert.deepEqual(run.events, ["o11y.rum.session.start", "o11y.rum.view.summary"]);
  assert.equal(run.unsubscribed, true);
});
