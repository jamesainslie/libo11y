import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { watchNetworkErrors } from "./network.ts";
import { createErrorRecorder } from "./recorder.ts";

test("a request that ends without a status is a network error named by its method and host", () => {
  const rt = fakeRuntime();
  const stop = watchNetworkErrors(rt, createErrorRecorder(rt));
  rt.bus.publish({
    type: "request-start",
    spanId: "a",
    method: "POST",
    url: "https://api.test/x?q=1",
    at: 1,
  });
  rt.bus.publish({ type: "request-end", spanId: "a", errorType: "TypeError", at: 2 });
  rt.bus.publish({ type: "request-start", spanId: "b", method: "GET", url: "https://api.test/y", at: 3 });
  rt.bus.publish({ type: "request-end", spanId: "b", status: 503, at: 4 });
  rt.bus.publish({ type: "request-start", spanId: "c", method: "GET", url: "https://api.test/z", at: 5 });
  rt.bus.publish({ type: "request-end", spanId: "c", errorType: "AbortError", at: 6 });
  stop();
  rt.bus.publish({ type: "request-start", spanId: "d", method: "GET", url: "https://api.test/z", at: 7 });
  rt.bus.publish({ type: "request-end", spanId: "d", at: 8 });
  assert.deepEqual(rt.counts, ["errors.network"]);
  assert.equal(rt.events[0]?.attrs["exception.type"], "NetworkError");
  assert.equal(rt.events[0]?.attrs["exception.message"], "POST api.test failed");
  assert.deepEqual(
    rt.signals.filter((s) => s.type === "error").map((s) => s.at),
    [2],
  );
});
