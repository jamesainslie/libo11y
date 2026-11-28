/**
 * The fixture runs this checkout's packages: every @libo11y package is the packed tarball's
 * contents, byte for byte, not a registry copy and not a cached copy of an earlier tarball.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = join(__dirname, "..");
const modules = join(root, "node_modules");
const packs = join(root, ".packs");

const manifest = (dir: string): { name: string; version: string; exports: Record<string, unknown> } =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

/** Every file under dir, as paths relative to it. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

const tarballs = readdirSync(packs).filter((f) => f.endsWith(".tgz"));

test.each(tarballs)("node_modules holds exactly the contents of .packs/%s", (tgz) => {
  const unpacked = mkdtempSync(join(tmpdir(), "fixture-pack-"));
  try {
    execFileSync("tar", ["-xzf", join(packs, tgz), "-C", unpacked, "--strip-components=1"]);
    const installed = join(modules, manifest(unpacked).name);
    expect(files(installed)).toEqual(files(unpacked));
    for (const f of files(unpacked)) {
      expect(readFileSync(join(installed, f)).equals(readFileSync(join(unpacked, f)))).toBe(true);
    }
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
});

test("the packed @libo11y/web has the ./portable entry the registry's 0.3.0 lacks", () => {
  expect(Object.keys(manifest(join(modules, "@libo11y/web")).exports)).toContain("./portable");
});

test("@libo11y/react-native exports ./expo, ./env and ./internal", () => {
  expect(Object.keys(manifest(join(modules, "@libo11y/react-native")).exports)).toEqual(
    expect.arrayContaining([".", "./expo", "./env", "./internal"]),
  );
});

test("@libo11y/rum-react-native exports ./expo and ./internal, and @libo11y/rum its portable ./core", () => {
  expect(Object.keys(manifest(join(modules, "@libo11y/rum-react-native")).exports)).toEqual(
    expect.arrayContaining([".", "./expo", "./internal"]),
  );
  expect(Object.keys(manifest(join(modules, "@libo11y/rum")).exports)).toContain("./core");
});

test("one copy of each @libo11y package, at one version, none nested in another package", () => {
  const names = [
    "@libo11y/core",
    "@libo11y/spec",
    "@libo11y/web",
    "@libo11y/webext",
    "@libo11y/react-native",
    "@libo11y/rum",
    "@libo11y/rum-react-native",
    "@libo11y/rum-react",
    "@libo11y/rum-connect",
    "@libo11y/rum-expo-router",
  ];
  expect(new Set(names.map((n) => manifest(join(modules, n)).version)).size).toBe(1);
  const nested = readdirSync(modules).flatMap((entry) => {
    const pkgs = entry.startsWith("@")
      ? readdirSync(join(modules, entry)).map((p) => `${entry}/${p}`)
      : [entry];
    return pkgs.filter((p) => existsSync(join(modules, p, "node_modules", "@libo11y")));
  });
  expect(nested).toEqual([]);
});
