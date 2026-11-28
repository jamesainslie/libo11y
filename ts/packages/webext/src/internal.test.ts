import assert from "node:assert/strict";
import { test } from "node:test";
import * as internal from "./internal.ts";

test("internal exports the content script and worker seams @libo11y/rum composes", () => {
  assert.equal(typeof internal.setupContentScriptWith, "function");
  assert.equal(typeof internal.defaultContentDeps, "function");
  assert.equal(typeof internal.setupWorkerWith, "function");
  assert.equal(typeof internal.defaultWorkerDeps, "function");
  const deps: internal.ContentDeps = internal.defaultContentDeps();
  assert.equal(typeof deps.webPlatform, "function");
  const worker: internal.WorkerDeps = internal.defaultWorkerDeps();
  assert.equal(typeof worker.createHttpTransport, "function");
});
