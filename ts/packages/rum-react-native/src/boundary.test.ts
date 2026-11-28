/**
 * The boundaries of @libo11y/rum-react-native: only env.ts loads React Native (through
 * `@libo11y/react-native/env`; index.ts and expo.ts reach it through env.ts), only expo.ts loads
 * the Expo modules (through `@libo11y/react-native/expo`), RUM comes only from the portable
 * `@libo11y/rum/core`, never the browser's `@libo11y/rum`, and the internal entry evaluates and
 * runs a session with every browser global removed, as on Hermes, without react-native or Expo.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { BROWSER_GLOBALS, valueImports } from "../../../scripts/import-graph.ts";

const SRC = import.meta.dirname;

/** The packages every module may import values from. */
const PORTABLE = new Set([
  "@libo11y/react-native/internal",
  "@libo11y/rum/core",
  "@libo11y/spec",
  "@opentelemetry/api",
]);

/** The packages only the named modules may reach, and the modules that do. */
const GUARDED: Readonly<Record<string, ReadonlySet<string>>> = {
  "@libo11y/react-native/env": new Set(["env.ts", "index.ts", "expo.ts"]),
  "@libo11y/react-native/expo": new Set(["expo.ts"]),
};

const ENTRIES: Readonly<Record<string, string>> = {
  ".": "index.ts",
  "./expo": "expo.ts",
  "./internal": "internal.ts",
};

function sources(dir: string, prefix = ""): string[] {
  return readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${prefix}${e.name}`;
    if (e.isDirectory()) return e.name === "test-support" ? [] : sources(join(dir, e.name), `${rel}/`);
    return rel.endsWith(".ts") && !rel.endsWith(".test.ts") && !rel.endsWith(".d.ts") ? [rel] : [];
  });
}

test("each module reaches only portable packages, and the guarded ones only where allowed", () => {
  for (const file of sources(".")) {
    const { packages, dynamic } = valueImports(join(SRC, file));
    assert.deepEqual([...dynamic], [], `${file}: a run-time import the graph cannot follow`);
    for (const p of packages) {
      const allowed = PORTABLE.has(p) || GUARDED[p]?.has(file) === true;
      assert.ok(allowed, `${file} reaches ${p}`);
    }
  }
  assert.ok(valueImports(join(SRC, "index.ts")).packages.has("@libo11y/react-native/env"));
  assert.ok(valueImports(join(SRC, "expo.ts")).packages.has("@libo11y/react-native/expo"));
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

test("the internal entry evaluates and runs a session with every browser global removed", () => {
  const harness = pathToFileURL(join(SRC, "test-support", "harness.ts")).href;
  const script = [
    `for (const k of ${JSON.stringify(BROWSER_GLOBALS)}) Object.defineProperty(globalThis, k, { value: undefined, configurable: true, writable: true });`,
    `const m = await import(${JSON.stringify(pathToFileURL(join(SRC, "internal.ts")).href)});`,
    `if (typeof m.setupRumReactNativeWith !== "function" || m.screensWith({}).name !== "views") throw new Error("no entry");`,
    `const { harness } = await import(${JSON.stringify(harness)});`,
    `const h = await harness({ consent: { initial: "granted" } }, { screens: true });`,
    `if (!/^[0-9a-f-]{36}$/.test(h.telemetry.rum.sessionId() ?? "")) throw new Error("no session");`,
    `h.app.setAppState("background");`,
    `await h.idle();`,
    `await h.telemetry.shutdown();`,
    `if (h.events("o11y.rum.view.summary").length !== 1) throw new Error("no summary");`,
    `console.log("ok");`,
  ].join("\n");
  // Bun runs this file under bun test; the child is always Node, which runs .ts by type stripping.
  const node = process.versions.bun === undefined ? process.execPath : "node";
  const out = execFileSync(node, ["--input-type=module", "-e", script], { cwd: SRC, encoding: "utf8" });
  assert.equal(out.trim().split("\n").at(-1), "ok");
});
