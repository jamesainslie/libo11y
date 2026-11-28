/**
 * The fixture runs this branch's packages: every @libo11y package comes from the packed tarballs,
 * not from the registry, whose copies lack this branch's changes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = (name: string): { version: string; exports: Record<string, unknown> } =>
  JSON.parse(readFileSync(join(__dirname, "..", "node_modules", name, "package.json"), "utf8"));

test("@libo11y/web is the packed copy, with the ./portable entry", () => {
  expect(Object.keys(manifest("@libo11y/web").exports)).toContain("./portable");
});

test("@libo11y/react-native exports ./expo, ./env and ./internal", () => {
  expect(Object.keys(manifest("@libo11y/react-native").exports)).toEqual(
    expect.arrayContaining([".", "./expo", "./env", "./internal"]),
  );
});

test("one copy of each @libo11y package, at one version", () => {
  const names = ["@libo11y/core", "@libo11y/spec", "@libo11y/web", "@libo11y/react-native"];
  expect(new Set(names.map((n) => manifest(n).version)).size).toBe(1);
  for (const n of names) {
    expect(require.resolve(n).startsWith(join(__dirname, "..", "node_modules", n))).toBe(true);
  }
});
