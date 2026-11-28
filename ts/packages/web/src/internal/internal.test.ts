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

test("internal exports the traceparent reader RUM's resource spans link with", () => {
  assert.equal(typeof internal.remoteParentFromTraceparent, "function");
  assert.equal(
    internal.remoteParentFromTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")?.spanId,
    "b7ad6b7169203331",
  );
});
