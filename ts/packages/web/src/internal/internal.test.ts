import assert from "node:assert/strict";
import { test } from "node:test";
import * as internal from "./index.ts";

test("internal exports the setup seam the RUM packages compose", () => {
  assert.equal(typeof internal.setupWithDeps, "function");
  assert.equal(typeof internal.defaultSetupDeps, "function");
  const deps: internal.SetupDeps = internal.defaultSetupDeps();
  assert.equal(typeof deps.createExporterSet, "function");
  assert.equal(typeof deps.createConsentController, "function");
});
