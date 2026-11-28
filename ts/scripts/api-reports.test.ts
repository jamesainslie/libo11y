import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";

const OUT_OF_SCOPE = /^@libo11y\/(?:rum(?:-.*)?|react-native|sourcemaps)$/;

// The entry points for libo11y packages only. They carry no compatibility promise, so a report of a
// public entry point must not depend on one.
const INTERNAL_ENTRY = /^@libo11y\/[^/']+\/(?:internal|portable|env|core)$/;

interface Package {
  readonly dir: string;
  readonly name: string;
  readonly entries: readonly string[];
}

function packages(): Package[] {
  const packagesDir = join(import.meta.dirname, "..", "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(packagesDir, e.name, "package.json")))
    .map((e) => {
      const dir = join(packagesDir, e.name);
      const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name: string;
        exports?: string | Record<string, unknown>;
      };
      const entries = typeof json.exports === "object" ? Object.keys(json.exports) : ["."];
      return { dir, name: json.name, entries };
    })
    .filter((p) => !OUT_OF_SCOPE.test(p.name));
}

// reportName is the report api-extractor writes for an entry point: <dir>.api.md for the root and
// <dir>-<subpath>.api.md for a subpath, as @libo11y/core/testing has core-testing.api.md.
function reportName(dir: string, entry: string): string {
  const base = basename(dir);
  return entry === "." ? `${base}.api.md` : `${base}-${entry.slice(2).replaceAll("/", "-")}.api.md`;
}

test("every entry point of the core and platform packages has an API report", () => {
  const pkgs = packages();
  assert.ok(pkgs.length >= 6, "expected at least spec, core, server, test, web and webext");
  for (const pkg of pkgs) {
    for (const entry of pkg.entries) {
      const report = join(pkg.dir, "api", reportName(pkg.dir, entry));
      assert.ok(existsSync(report), `${pkg.name} exports ${entry} and has no report ${report}`);
    }
  }
});

test("no API report has a symbol its entry point forgets to export", () => {
  for (const pkg of packages()) {
    for (const entry of pkg.entries) {
      const report = join(pkg.dir, "api", reportName(pkg.dir, entry));
      if (!existsSync(report)) continue;
      const forgotten = readFileSync(report, "utf8")
        .split("\n")
        .filter((line) => line.includes("(ae-forgotten-export)"));
      assert.deepEqual(forgotten, [], `${report} has forgotten exports`);
    }
  }
});

test("the report of a public entry point imports nothing from an internal entry point", () => {
  for (const pkg of packages()) {
    for (const entry of pkg.entries) {
      if (INTERNAL_ENTRY.test(`${pkg.name}${entry.slice(1)}`)) continue;
      const report = join(pkg.dir, "api", reportName(pkg.dir, entry));
      if (!existsSync(report)) continue;
      const internal = [...readFileSync(report, "utf8").matchAll(/^import .* from '([^']+)';$/gm)]
        .map((m) => m[1] ?? "")
        .filter((from) => INTERNAL_ENTRY.test(from));
      assert.deepEqual(internal, [], `${report} imports from an internal entry point`);
    }
  }
});
