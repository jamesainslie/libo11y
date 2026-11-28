import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { VERSION } from "./version.ts";

test("VERSION is the package version", () => {
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8")) as {
    version: string;
  };
  assert.equal(VERSION, pkg.version);
});
