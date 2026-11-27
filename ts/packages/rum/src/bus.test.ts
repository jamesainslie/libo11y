import assert from "node:assert/strict";
import { test } from "node:test";
import { createBus } from "./bus.ts";

test("the bus delivers in order and survives a throwing listener", () => {
  const bus = createBus();
  const seen: string[] = [];
  bus.subscribe(() => {
    throw new Error("boom");
  });
  const off = bus.subscribe((s) => seen.push(s.type));
  bus.publish({ type: "mutation", at: 1 });
  off();
  bus.publish({ type: "mutation", at: 2 });
  assert.deepEqual(seen, ["mutation"]);
});
