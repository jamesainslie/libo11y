import assert from "node:assert/strict";
import { test } from "node:test";
import { SPEC_VERSION } from "@libo11y/spec";

// Imports the package by name, so a run proves the workspace resolves under both runtimes.
test("the package resolves by name", () => {
  assert.equal(SPEC_VERSION, "1.2.0");
});

test("the runtime is the one the run reports", () => {
  const underBun = typeof process.versions.bun === "string";
  assert.equal(typeof Bun !== "undefined", underBun);
});
