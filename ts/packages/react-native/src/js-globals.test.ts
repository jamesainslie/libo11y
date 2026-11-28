import assert from "node:assert/strict";
import { test } from "node:test";
import { jsGlobals } from "./js-globals.ts";

test("ErrorUtils and HermesInternal are read from the global object", () => {
  const handler = (): void => {};
  const errorUtils = { getGlobalHandler: () => handler, setGlobalHandler: () => {} };
  const hermes = { enablePromiseRejectionTracker: () => {}, hasPromise: () => true };
  const g = jsGlobals({ ErrorUtils: errorUtils, HermesInternal: hermes });
  assert.equal(g.errorUtils, errorUtils);
  assert.equal(g.hermes, hermes);
});

test("missing, null or malformed globals, as on Expo web or JSC, are absent", () => {
  assert.deepEqual(jsGlobals({}), {});
  assert.deepEqual(jsGlobals({ ErrorUtils: null, HermesInternal: null }), {});
  assert.deepEqual(jsGlobals({ ErrorUtils: { getGlobalHandler: 1 }, HermesInternal: 5 }), {});
});
