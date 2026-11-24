/**
 * Versions and packs the @libo11y/* packages for npm. The packages are lockstep: one version for all.
 *
 *   bun scripts/release.ts version X.Y.Z
 *   bun scripts/release.ts pack OUTDIR [--allow-unreleased]
 *
 * `pack` stages each package with a publishable package.json (exact versions in place of workspace:
 * ranges, exports and bin pointed at dist) and runs `npm pack` in the staging directory. Bun's own
 * pack writes stale versions on 1.3.13 (oven-sh/bun#18906), and changesets packs workspace: ranges
 * unchanged on Bun workspaces (changesets/changesets#1468), so neither is used.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

/** The package.json fields the release steps read or rewrite. Every other field passes through. */
export interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  exports?: string | Record<string, unknown>;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
  publishConfig?: Record<string, unknown>;
  [field: string]: unknown;
}

/** Options for {@link pack}. */
export interface PackOptions {
  /** Accept version 0.0.0, which the release check packs before any release. */
  allowUnreleased: boolean;
  /** Do not print the tarball paths. */
  quiet?: boolean;
  /** The LICENSE file every tarball carries. Defaults to the repository's, beside the workspace. */
  license?: string;
}

const SCOPE = "@libo11y/";
const UNRELEASED = "0.0.0";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
] as const;

// The semver.org regular expression for a version without a leading v.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Orders packages so each comes after the @libo11y/* packages it depends on, ties by name. */
export function packOrder(pkgs: readonly PackageJson[]): PackageJson[] {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const sorted = [...pkgs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const order: PackageJson[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (pkg: PackageJson, path: readonly string[]): void => {
    const seen = state.get(pkg.name);
    if (seen === "done") return;
    if (seen === "visiting") {
      throw new Error(`release: dependency cycle: ${[...path, pkg.name].join(" -> ")}`);
    }
    state.set(pkg.name, "visiting");
    for (const dep of Object.keys(pkg.dependencies ?? {}).sort()) {
      const target = byName.get(dep);
      if (dep.startsWith(SCOPE) && target !== undefined) visit(target, [...path, pkg.name]);
    }
    state.set(pkg.name, "done");
    order.push(pkg);
  };
  for (const pkg of sorted) visit(pkg, []);
  return order;
}

// distPath maps a source module path such as ./src/cli.ts to its built form ./dist/cli.js.
function distPath(path: string, ext: ".js" | ".d.ts"): string {
  const m = /^\.\/src\/(.+)\.ts$/.exec(path);
  return m === null ? path : `./dist/${m[1]}${ext}`;
}

function stageExport(target: unknown): unknown {
  if (typeof target === "string") {
    return distPath(target, ".js") === target
      ? target
      : { types: distPath(target, ".d.ts"), default: distPath(target, ".js") };
  }
  return target;
}

/** Returns the package.json to publish for pkg at version. pkg itself is not changed. */
export function stagePackageJson(pkg: PackageJson, version: string): PackageJson {
  const staged: PackageJson = structuredClone(pkg);
  staged.version = version;
  delete staged.private;
  delete staged.scripts;
  for (const field of DEPENDENCY_FIELDS) {
    const deps = staged[field];
    if (deps === undefined) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (range.startsWith("workspace:")) deps[name] = version;
    }
  }
  if (typeof staged.exports === "string") {
    staged.exports = { ".": stageExport(staged.exports) };
  } else if (staged.exports !== undefined) {
    staged.exports = Object.fromEntries(Object.entries(staged.exports).map(([k, v]) => [k, stageExport(v)]));
  }
  if (typeof staged.bin === "string") {
    staged.bin = distPath(staged.bin, ".js");
  } else if (staged.bin !== undefined) {
    staged.bin = Object.fromEntries(Object.entries(staged.bin).map(([k, v]) => [k, distPath(v, ".js")]));
  }
  staged.files = ["dist", "README.md", "LICENSE"];
  staged.publishConfig = { access: "public", provenance: true };
  return staged;
}

interface WorkspacePackage {
  readonly dir: string;
  readonly json: PackageJson;
}

function readPackages(root: string): WorkspacePackage[] {
  const packagesDir = join(root, "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(packagesDir, e.name, "package.json")))
    .map((e) => {
      const dir = join(packagesDir, e.name);
      return { dir, json: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson };
    });
}

function writePackageJson(path: string, pkg: PackageJson): void {
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

// A package that reports its own version at runtime keeps it in src/version.ts as one constant.
const VERSION_CONSTANT = /^export const VERSION = ".*";$/m;

/**
 * Sets version in every packages/* package.json under the workspace root, and in the VERSION constant
 * of each package's src/version.ts where it has one.
 */
export function setVersion(root: string, version: string): void {
  if (!SEMVER.test(version)) {
    throw new Error(`release: version ${JSON.stringify(version)} is not semver X.Y.Z`);
  }
  for (const { dir, json } of readPackages(root)) {
    json.version = version;
    writePackageJson(join(dir, "package.json"), json);
    const versionFile = join(dir, "src", "version.ts");
    if (existsSync(versionFile)) {
      const text = readFileSync(versionFile, "utf8");
      if (!VERSION_CONSTANT.test(text)) throw new Error(`release: ${versionFile} has no VERSION constant`);
      writeFileSync(versionFile, text.replace(VERSION_CONSTANT, `export const VERSION = "${version}";`));
    }
  }
}

// keep reports whether a path inside a package directory belongs in the staging copy.
function keep(pkgDir: string, path: string): boolean {
  const rel = relative(pkgDir, path);
  if (rel === "") return true;
  const parts = rel.split(sep);
  const top = parts[0] ?? "";
  if (parts.includes("node_modules") || top === "api" || top.startsWith("tsconfig")) return false;
  if (top === "dist" && parts[1] === "api-tmp") return false;
  if (top === "src" && rel.endsWith(".test.ts")) return false;
  return true;
}

// staleOutputs finds a dist JavaScript file left by a source that has since been removed or renamed,
// which a build without a clean would leave in the tarball.
function staleOutputs(pkgDir: string): { js: string; ts: string } | undefined {
  const dist = join(pkgDir, "dist");
  for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const rel = relative(dist, join(entry.parentPath, entry.name));
    const source = `${rel.slice(0, -".js".length)}.ts`;
    if (!existsSync(join(pkgDir, "src", source))) {
      return { js: ["dist", ...rel.split(sep)].join("/"), ts: ["src", ...source.split(sep)].join("/") };
    }
  }
  return undefined;
}

/** Packs every package into outDir in dependency order and returns the tarball paths. */
export function pack(root: string, outDir: string, opts: PackOptions): string[] {
  const license = opts.license ?? resolve(root, "..", "LICENSE");
  if (!existsSync(license)) throw new Error(`release: no LICENSE at ${license}`);
  const pkgs = readPackages(root);
  const dirs = new Map(pkgs.map((p) => [p.json.name, p.dir]));
  for (const { dir, json } of pkgs) {
    if (!existsSync(join(dir, "dist"))) {
      throw new Error(`release: ${json.name} has no dist; run bun run build first`);
    }
    const stale = staleOutputs(dir);
    if (stale !== undefined) {
      throw new Error(
        `release: ${json.name}: ${stale.js} has no source ${stale.ts}; rebuild with bun run build`,
      );
    }
    if ((json.version ?? UNRELEASED) === UNRELEASED && !opts.allowUnreleased) {
      throw new Error(`release: ${json.name} is at version ${UNRELEASED}; run the version command first`);
    }
  }
  mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir);
  const staging = mkdtempSync(join(tmpdir(), "libo11y-pack-"));
  try {
    return packOrder(pkgs.map((p) => p.json)).map((json) => {
      const dir = dirs.get(json.name) ?? "";
      const stage = join(staging, json.name.replace("/", "-"));
      cpSync(dir, stage, { recursive: true, filter: (src) => keep(dir, src) });
      cpSync(license, join(stage, "LICENSE"));
      writePackageJson(join(stage, "package.json"), stagePackageJson(json, json.version));
      const result = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", out], {
        cwd: stage,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const [entry] = JSON.parse(result) as { filename: string }[];
      if (entry === undefined) throw new Error(`release: npm pack wrote no tarball for ${json.name}`);
      const tarball = join(out, entry.filename);
      if (opts.quiet !== true) console.log(tarball);
      return tarball;
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const USAGE = "usage: release.ts version X.Y.Z | pack OUTDIR [--allow-unreleased]";

/** Runs the command line and returns the exit status. */
export function main(args: readonly string[], root: string): number {
  const [command, arg, ...rest] = args;
  try {
    if (command === "version" && arg !== undefined && rest.length === 0) {
      setVersion(root, arg);
      return 0;
    }
    if (command === "pack" && arg !== undefined && rest.every((r) => r === "--allow-unreleased")) {
      pack(root, arg, { allowUnreleased: rest.length > 0 });
      return 0;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), resolve(import.meta.dirname, "..")));
}
