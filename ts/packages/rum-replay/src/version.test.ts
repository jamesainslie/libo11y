import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { VERSION } from "./version.ts";

interface Manifest {
  readonly version: string;
  readonly private?: boolean;
  readonly dependencies: Readonly<Record<string, string>>;
}

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8")) as Manifest;

test("VERSION is the package version", () => {
  assert.equal(VERSION, pkg.version);
});

test("the package is lockstep with @libo11y/web and stays private until released", () => {
  const web = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", "..", "web", "package.json"), "utf8"),
  ) as Manifest;
  assert.equal(pkg.version, web.version);
  assert.equal(pkg.private, true);
});

test("rrweb is pinned exactly", () => {
  assert.equal(pkg.dependencies["@rrweb/record"], "2.2.2");
  assert.equal(pkg.dependencies["@rrweb/types"], "2.2.2");
});
