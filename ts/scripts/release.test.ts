import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type PackageJson, pack, packOrder, setVersion, stagePackageJson } from "./release.ts";

const spec: PackageJson = {
  name: "@libo11y/spec",
  version: "0.0.0",
  private: true,
  type: "module",
  exports: { ".": "./src/index.ts", "./yaml": "./src/yaml.ts" },
  bin: { libo11y: "./src/cli.ts" },
  dependencies: { yaml: "2.9.1" },
  scripts: { build: "tsc -p tsconfig.build.json" },
};

const core: PackageJson = {
  name: "@libo11y/core",
  version: "0.0.0",
  private: true,
  exports: { ".": "./src/index.ts" },
  dependencies: { "@libo11y/spec": "workspace:*" },
  peerDependencies: { "@libo11y/spec": "workspace:^" },
};

const server: PackageJson = {
  name: "@libo11y/server",
  version: "0.0.0",
  dependencies: { "@libo11y/core": "workspace:*", "@libo11y/spec": "workspace:*" },
};

test("packOrder puts each package after the packages it depends on", () => {
  const order = packOrder([server, core, spec]).map((p) => p.name);
  assert.deepEqual(order, ["@libo11y/spec", "@libo11y/core", "@libo11y/server"]);
});

test("packOrder keeps independent packages in name order", () => {
  const test_: PackageJson = {
    name: "@libo11y/test",
    version: "0.0.0",
    dependencies: { "@libo11y/core": "workspace:*" },
  };
  const order = packOrder([test_, server, core, spec]).map((p) => p.name);
  assert.deepEqual(order, ["@libo11y/spec", "@libo11y/core", "@libo11y/server", "@libo11y/test"]);
});

test("packOrder rejects a dependency cycle", () => {
  const a: PackageJson = {
    name: "@libo11y/a",
    version: "0.0.0",
    dependencies: { "@libo11y/b": "workspace:*" },
  };
  const b: PackageJson = {
    name: "@libo11y/b",
    version: "0.0.0",
    dependencies: { "@libo11y/a": "workspace:*" },
  };
  assert.throws(() => packOrder([a, b]), /cycle/);
});

test("stagePackageJson points exports and bin at dist", () => {
  const staged = stagePackageJson(spec, "1.2.3");
  assert.equal(staged.version, "1.2.3");
  assert.deepEqual(staged.exports, {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./yaml": { types: "./dist/yaml.d.ts", default: "./dist/yaml.js" },
  });
  assert.deepEqual(staged.bin, { libo11y: "./dist/cli.js" });
  assert.deepEqual(staged.dependencies, { yaml: "2.9.1" });
});

test("stagePackageJson drops private and scripts and sets files and publishConfig", () => {
  const staged = stagePackageJson(spec, "1.2.3");
  assert.equal("private" in staged, false);
  assert.equal("scripts" in staged, false);
  assert.deepEqual(staged.files, ["dist", "README.md", "LICENSE"]);
  assert.deepEqual(staged.publishConfig, { access: "public", provenance: true });
  assert.equal(staged.type, "module");
});

test("stagePackageJson pins every workspace dependency to the exact version", () => {
  const staged = stagePackageJson(core, "1.2.3");
  assert.deepEqual(staged.dependencies, { "@libo11y/spec": "1.2.3" });
  assert.deepEqual(staged.peerDependencies, { "@libo11y/spec": "1.2.3" });
  assert.equal(JSON.stringify(staged).includes("workspace:"), false);
});

test("stagePackageJson maps a string export and a string bin", () => {
  const staged = stagePackageJson(
    { name: "@libo11y/x", version: "0.0.0", exports: "./src/index.ts", bin: "./src/cli.ts" },
    "1.0.0",
  );
  assert.deepEqual(staged.exports, { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } });
  assert.equal(staged.bin, "./dist/cli.js");
});

test("stagePackageJson leaves the input unchanged", () => {
  const before = JSON.stringify(core);
  stagePackageJson(core, "1.2.3");
  assert.equal(JSON.stringify(core), before);
});

const work = mkdtempSync(join(tmpdir(), "libo11y-release-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// fixture writes a two-package workspace: @libo11y/fx-b depends on @libo11y/fx-a and has a bin.
function fixture(name: string, withDist = true): string {
  const root = join(work, name, "ts");
  writeFileSync(join(mkdirAll(join(work, name)), "LICENSE"), "fixture license\n");
  for (const [dir, pkg] of [
    ["fx-a", { name: "@libo11y/fx-a", version: "0.0.0", private: true, exports: { ".": "./src/index.ts" } }],
    [
      "fx-b",
      {
        name: "@libo11y/fx-b",
        version: "0.0.0",
        private: true,
        exports: { ".": "./src/index.ts" },
        bin: { fxb: "./src/cli.ts" },
        dependencies: { "@libo11y/fx-a": "workspace:*" },
        scripts: { build: "tsc" },
      },
    ],
  ] as const) {
    const pkgDir = mkdirAll(join(root, "packages", dir));
    writeJson(join(pkgDir, "package.json"), pkg);
    writeFileSync(join(pkgDir, "tsconfig.build.json"), "{}\n");
    writeFileSync(join(mkdirAll(join(pkgDir, "src")), "index.ts"), "export const x = 1;\n");
    writeFileSync(join(pkgDir, "src", "index.test.ts"), "\n");
    writeFileSync(join(mkdirAll(join(pkgDir, "api")), `${dir}.api.md`), "report\n");
    if (withDist) {
      writeFileSync(join(mkdirAll(join(pkgDir, "dist")), "index.js"), "export const x = 1;\n");
      writeFileSync(join(pkgDir, "dist", "index.d.ts"), "export declare const x = 1;\n");
      writeFileSync(join(pkgDir, "dist", "cli.js"), "#!/usr/bin/env node\n");
      writeFileSync(join(mkdirAll(join(pkgDir, "dist", "api-tmp")), `${dir}.api.md`), "tmp\n");
    }
  }
  return root;
}

function mkdirAll(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function tarFile(tarball: string, path: string): string {
  return execFileSync("tar", ["-xOf", tarball, path], { encoding: "utf8" });
}

function tarList(tarball: string): string[] {
  return execFileSync("tar", ["-tf", tarball], { encoding: "utf8" }).trim().split("\n").sort();
}

test("setVersion sets every package version and keeps the file format", () => {
  const root = fixture("version");
  setVersion(root, "2.3.4");
  const raw = readFileSync(join(root, "packages", "fx-b", "package.json"), "utf8");
  const pkg = JSON.parse(raw) as PackageJson;
  assert.equal(pkg.version, "2.3.4");
  assert.equal(raw, `${JSON.stringify(pkg, null, 2)}\n`);
  assert.deepEqual(pkg.dependencies, { "@libo11y/fx-a": "workspace:*" });
  assert.equal(
    (JSON.parse(readFileSync(join(root, "packages", "fx-a", "package.json"), "utf8")) as PackageJson).version,
    "2.3.4",
  );
});

test("setVersion rejects a version that is not semver", () => {
  const root = fixture("bad-version");
  assert.throws(() => setVersion(root, "1.2"), /semver/);
  assert.throws(() => setVersion(root, "v1.2.3"), /semver/);
});

test("pack writes publishable tarballs in dependency order", () => {
  const root = fixture("pack");
  setVersion(root, "1.0.0");
  const out = join(work, "pack-out");
  const tarballs = pack(root, out, { allowUnreleased: false, quiet: true });
  assert.deepEqual(
    tarballs.map((t) => t.slice(out.length + 1)),
    ["libo11y-fx-a-1.0.0.tgz", "libo11y-fx-b-1.0.0.tgz"],
  );
  const b = tarballs[1] ?? "";
  const pkg = JSON.parse(tarFile(b, "package/package.json")) as PackageJson;
  assert.deepEqual(pkg.dependencies, { "@libo11y/fx-a": "1.0.0" });
  assert.deepEqual(pkg.bin, { fxb: "./dist/cli.js" });
  assert.equal("private" in pkg, false);
  assert.equal(JSON.stringify(pkg).includes("workspace:"), false);
  assert.deepEqual(tarList(b), [
    "package/LICENSE",
    "package/dist/cli.js",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/package.json",
  ]);
  assert.equal(tarFile(b, "package/LICENSE"), "fixture license\n");
});

test("pack refuses version 0.0.0 unless unreleased packages are allowed", () => {
  const root = fixture("unreleased");
  const out = join(work, "unreleased-out");
  assert.throws(() => pack(root, out, { allowUnreleased: false, quiet: true }), /0\.0\.0/);
  assert.equal(pack(root, out, { allowUnreleased: true, quiet: true }).length, 2);
});

test("pack refuses a package with no dist", () => {
  const root = fixture("no-dist", false);
  assert.throws(() => pack(root, join(work, "no-dist-out"), { allowUnreleased: true, quiet: true }), /dist/);
});
