import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  lockfileWorkspaces,
  type PackageJson,
  pack,
  packOrder,
  setVersion,
  stagePackageJson,
} from "./release.ts";

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

test("stagePackageJson passes peer and dev dependency ranges through unchanged", () => {
  const staged = stagePackageJson(
    {
      name: "@libo11y/x",
      version: "0.0.0",
      dependencies: { "@opentelemetry/core": "3.1.1" },
      peerDependencies: { "@opentelemetry/api": ">=1.10.0 <1.11.0" },
      devDependencies: { "@opentelemetry/api": "1.10.0" },
    },
    "1.0.0",
  );
  assert.deepEqual(staged.dependencies, { "@opentelemetry/core": "3.1.1" });
  assert.deepEqual(staged.peerDependencies, { "@opentelemetry/api": ">=1.10.0 <1.11.0" });
  assert.deepEqual(staged.devDependencies, { "@opentelemetry/api": "1.10.0" });
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
        peerDependencies: { "@opentelemetry/api": ">=1.10.0 <1.11.0" },
        devDependencies: { "@opentelemetry/api": "1.10.0" },
        scripts: { build: "tsc" },
      },
    ],
  ] as const) {
    const pkgDir = mkdirAll(join(root, "packages", dir));
    writeJson(join(pkgDir, "package.json"), pkg);
    writeFileSync(join(pkgDir, "tsconfig.build.json"), "{}\n");
    writeFileSync(join(mkdirAll(join(pkgDir, "src")), "index.ts"), "export const x = 1;\n");
    writeFileSync(join(pkgDir, "src", "index.test.ts"), "\n");
    writeFileSync(join(pkgDir, "src", "cli.ts"), "#!/usr/bin/env node\n");
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

test("setVersion rewrites a package's src/version.ts and leaves packages without one alone", () => {
  const root = fixture("version-file");
  const versionFile = join(root, "packages", "fx-a", "src", "version.ts");
  writeFileSync(versionFile, '/** The package version. */\nexport const VERSION = "0.0.0";\n');
  setVersion(root, "2.3.4");
  assert.equal(
    readFileSync(versionFile, "utf8"),
    '/** The package version. */\nexport const VERSION = "2.3.4";\n',
  );
  assert.equal(existsSync(join(root, "packages", "fx-b", "src", "version.ts")), false);
});

test("setVersion rejects a version that is not semver", () => {
  const root = fixture("bad-version");
  assert.throws(() => setVersion(root, "1.2"), /semver/);
  assert.throws(() => setVersion(root, "v1.2.3"), /semver/);
});

// lockfile writes a bun.lock for the fixture workspace in the layout bun 1.3.13 writes.
function lockfile(versionA: string, versionB: string): string {
  return [
    "{",
    '  "lockfileVersion": 1,',
    '  "configVersion": 1,',
    '  "workspaces": {',
    '    "": {',
    '      "name": "fixture",',
    "    },",
    '    "packages/fx-a": {',
    '      "name": "@libo11y/fx-a",',
    `      "version": "${versionA}",`,
    "    },",
    '    "packages/fx-b": {',
    '      "name": "@libo11y/fx-b",',
    `      "version": "${versionB}",`,
    '      "dependencies": {',
    '        "@libo11y/fx-a": "workspace:*",',
    "      },",
    "    },",
    "  },",
    '  "packages": {',
    '    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-x"],',
    '    "other": ["other@1.0.0", "", { "version": "0.0.0" }, "sha512-y"],',
    "  }",
    "}",
    "",
  ].join("\n");
}

test("lockfileWorkspaces reads each package workspace's name and version", () => {
  assert.deepEqual(
    lockfileWorkspaces(lockfile("1.0.0", "1.0.1")),
    new Map([
      ["packages/fx-a", { name: "@libo11y/fx-a", version: "1.0.0" }],
      ["packages/fx-b", { name: "@libo11y/fx-b", version: "1.0.1" }],
    ]),
  );
});

test("setVersion sets the workspace versions in bun.lock and changes nothing else", () => {
  const root = fixture("version-lock");
  writeFileSync(join(root, "bun.lock"), lockfile("0.0.0", "0.0.0"));
  setVersion(root, "2.3.4");
  assert.equal(readFileSync(join(root, "bun.lock"), "utf8"), lockfile("2.3.4", "2.3.4"));
});

test("setVersion refuses a bun.lock that has no workspace for a package", () => {
  const root = fixture("version-lock-missing");
  writeFileSync(
    join(root, "bun.lock"),
    lockfile("0.0.0", "0.0.0").replace('"packages/fx-b"', '"packages/fx-c"'),
  );
  assert.throws(
    () => setVersion(root, "2.3.4"),
    /bun\.lock has no workspace packages\/fx-b; run bun install/,
  );
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
  assert.deepEqual(pkg.peerDependencies, { "@opentelemetry/api": ">=1.10.0 <1.11.0" });
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

test("pack and setVersion skip the private example workspaces", () => {
  const root = fixture("examples");
  const example = mkdirAll(join(root, "examples", "fx-app"));
  const examplePkg = {
    name: "libo11y-example-fx-app",
    version: "0.0.0",
    private: true,
    dependencies: { "@libo11y/fx-a": "workspace:*" },
  };
  writeJson(join(example, "package.json"), examplePkg);
  writeFileSync(join(example, "main.ts"), "export {};\n");
  setVersion(root, "1.0.0");
  assert.deepEqual(JSON.parse(readFileSync(join(example, "package.json"), "utf8")), examplePkg);
  const out = join(work, "examples-out");
  const tarballs = pack(root, out, { allowUnreleased: false, quiet: true });
  assert.deepEqual(
    tarballs.map((t) => t.slice(out.length + 1)),
    ["libo11y-fx-a-1.0.0.tgz", "libo11y-fx-b-1.0.0.tgz"],
  );
});

test("the repository's examples are private, so no publish can include them", () => {
  const examples = join(import.meta.dirname, "..", "examples");
  const names = readdirSync(examples, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(names.length >= 2, "expected the bun-server and node-server examples");
  for (const entry of names) {
    const pkg = JSON.parse(readFileSync(join(examples, entry.name, "package.json"), "utf8")) as PackageJson;
    assert.equal(pkg.private, true, `${entry.name} is not private`);
    assert.equal(pkg.name.startsWith("@libo11y/"), false, `${entry.name} takes a published scope name`);
  }
});

// The repository's packages, read the way pack reads them: every packages/* directory with a package.json.
function repositoryPackages(): PackageJson[] {
  const packagesDir = join(import.meta.dirname, "..", "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(packagesDir, e.name, "package.json")))
    .map((e) => JSON.parse(readFileSync(join(packagesDir, e.name, "package.json"), "utf8")) as PackageJson);
}

test("the repository's packages publish spec first, then core, each after its @libo11y/* dependencies", () => {
  const order = packOrder(repositoryPackages());
  const names = order.map((p) => p.name);
  assert.deepEqual(names.slice(0, 2), ["@libo11y/spec", "@libo11y/core"]);
  for (const [i, pkg] of order.entries()) {
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!dep.startsWith("@libo11y/")) continue;
      const at = names.indexOf(dep);
      assert.ok(at !== -1, `${pkg.name} depends on ${dep}, which is not a workspace package`);
      assert.ok(at < i, `${pkg.name} publishes before its dependency ${dep}`);
    }
  }
});

test("the repository's packages are all in the @libo11y scope and share one version", () => {
  const pkgs = repositoryPackages();
  assert.ok(pkgs.length >= 4, "expected at least spec, core, server and test");
  for (const pkg of pkgs) {
    assert.ok(pkg.name.startsWith("@libo11y/"), `${pkg.name} is outside the @libo11y scope`);
    assert.equal(pkg.version, pkgs[0]?.version, `${pkg.name} is not at the lockstep version`);
  }
});

test("the repository's bun.lock records every package at its package.json version", () => {
  const root = join(import.meta.dirname, "..");
  const locked = lockfileWorkspaces(readFileSync(join(root, "bun.lock"), "utf8"));
  const packagesDir = join(root, "packages");
  const dirs = readdirSync(packagesDir, { withFileTypes: true }).filter(
    (e) => e.isDirectory() && existsSync(join(packagesDir, e.name, "package.json")),
  );
  assert.ok(dirs.length >= 4, "expected at least spec, core, server and test");
  for (const entry of dirs) {
    const pkg = JSON.parse(
      readFileSync(join(packagesDir, entry.name, "package.json"), "utf8"),
    ) as PackageJson;
    const lock = locked.get(`packages/${entry.name}`);
    assert.ok(lock !== undefined, `bun.lock has no workspace packages/${entry.name}; run bun install`);
    assert.equal(lock.name, pkg.name, `bun.lock names packages/${entry.name} ${lock.name}`);
    assert.equal(
      lock.version,
      pkg.version,
      `bun.lock has ${pkg.name} at ${lock.version}, package.json at ${pkg.version}; run bun install`,
    );
  }
});

// The packages that take the OpenTelemetry API as a peer, as every upstream SDK package does, so an
// application and libo11y share the one process-wide API. The RUM and React Native packages belong to
// another program and are not listed yet.
const API_PEERS = ["core", "server", "test", "web", "webext"];

test("the platform packages take @opentelemetry/api as a peer in upstream's range and lock it for development", () => {
  const packagesDir = join(import.meta.dirname, "..", "packages");
  const upstream = JSON.parse(
    readFileSync(
      join(packagesDir, "core", "node_modules", "@opentelemetry", "sdk-trace", "package.json"),
      "utf8",
    ),
  ) as PackageJson;
  const range = upstream.peerDependencies?.["@opentelemetry/api"];
  assert.ok(range !== undefined, "@opentelemetry/sdk-trace has no @opentelemetry/api peer");
  for (const dir of API_PEERS) {
    const pkg = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8")) as PackageJson;
    assert.equal(
      pkg.dependencies?.["@opentelemetry/api"],
      undefined,
      `${pkg.name} depends on @opentelemetry/api`,
    );
    assert.equal(
      pkg.peerDependencies?.["@opentelemetry/api"],
      range,
      `${pkg.name}'s @opentelemetry/api peer`,
    );
    assert.match(
      pkg.devDependencies?.["@opentelemetry/api"] ?? "",
      /^\d+\.\d+\.\d+$/,
      `${pkg.name} does not lock @opentelemetry/api to an exact version for development`,
    );
  }
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

test("pack refuses a dist file whose source is gone", () => {
  const root = fixture("stale-dist");
  const dist = join(root, "packages", "fx-a", "dist");
  writeFileSync(join(mkdirAll(join(dist, "old")), "gone.js"), "export {};\n");
  assert.throws(
    () => pack(root, join(work, "stale-dist-out"), { allowUnreleased: true, quiet: true }),
    /@libo11y\/fx-a: dist\/old\/gone\.js has no source src\/old\/gone\.ts; rebuild/,
  );
});

test("pack refuses a declaration or source map whose source is gone", () => {
  for (const [i, file] of ["gone.d.ts", "gone.d.ts.map", "gone.js.map"].entries()) {
    const root = fixture(`stale-${i}`);
    const dist = join(root, "packages", "fx-a", "dist");
    writeFileSync(join(mkdirAll(join(dist, "old")), file), "\n");
    assert.throws(
      () => pack(root, join(work, `stale-${i}-out`), { allowUnreleased: true, quiet: true }),
      new RegExp(
        `@libo11y/fx-a: dist/old/${file.replaceAll(".", "\\.")} has no source src/old/gone\\.ts; rebuild`,
      ),
    );
  }
});
