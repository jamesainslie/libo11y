import assert from "node:assert/strict";
import { test } from "node:test";
import { RUM_ERROR_SOURCE_VALUES, RUM_FRUSTRATION_TYPE_VALUES, SENSITIVITY_OF } from "@libo11y/spec";
import { summaryCountKey, summaryVitalKey } from "./attrs.ts";
import type { SummaryCountKey, VitalName } from "./contracts/summary.ts";

test("every summary key the accumulator can build is registered in the spec", () => {
  const counts: SummaryCountKey[] = [
    ...RUM_ERROR_SOURCE_VALUES.map((s) => `errors.${s}` as const),
    ...RUM_FRUSTRATION_TYPE_VALUES.map((f) => `frustrations.${f}` as const),
    "requests",
    "long_animation_frames",
  ];
  const vitals: VitalName[] = ["lcp", "inp", "cls", "fcp", "ttfb"];
  for (const key of [...counts.map(summaryCountKey), ...vitals.map(summaryVitalKey)]) {
    assert.equal(SENSITIVITY_OF.get(key), "public", key);
  }
});
