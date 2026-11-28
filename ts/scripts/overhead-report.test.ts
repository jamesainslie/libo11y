import assert from "node:assert/strict";
import { test } from "node:test";
import { type OverheadResult, parseLimits, parseOverhead, reportOverhead } from "./overhead-report.ts";

const RESULT: OverheadResult = {
  browser: "chromium 140.0.0.0",
  runs: 5,
  viewMillis: 3.456,
  interactionMillis: 1.2,
  baseline: { views: 410.5, interactions: 220 },
  withRum: { views: 479.62, interactions: 280 },
};

test("the report has one row per measure, in milliseconds to two decimals", () => {
  const { markdown, over } = reportOverhead(RESULT, { maxViewMillis: 8, maxInteractionMillis: 4 });
  assert.deepEqual(over, []);
  assert.match(markdown, /chromium 140\.0\.0\.0, median of 5 runs/);
  assert.match(markdown, /\| per view \| 3\.46 \| 8\.00 \| ok \|/);
  assert.match(markdown, /\| per interaction \| 1\.20 \| 4\.00 \| ok \|/);
});

test("a measure above its limit is listed as over", () => {
  const { markdown, over } = reportOverhead(
    { ...RESULT, viewMillis: 8.01, interactionMillis: 4.5 },
    { maxViewMillis: 8, maxInteractionMillis: 4 },
  );
  assert.deepEqual(over, ["per view 8.01 ms > 8.00 ms", "per interaction 4.50 ms > 4.00 ms"]);
  assert.match(markdown, /\| per view \| 8\.01 \| 8\.00 \| over \|/);
});

test("without limits nothing is over and the limit column is empty", () => {
  const { markdown, over } = reportOverhead(RESULT, {});
  assert.deepEqual(over, []);
  assert.match(markdown, /\| per view \| 3\.46 \| - \| ok \|/);
});

test("parseOverhead refuses a result without numbers where they belong", () => {
  assert.deepEqual(parseOverhead(JSON.parse(JSON.stringify(RESULT))), RESULT);
  assert.throws(() => parseOverhead({ ...RESULT, viewMillis: "3" }), /viewMillis/);
  assert.throws(() => parseOverhead({ ...RESULT, withRum: { views: 1 } }), /withRum/);
  assert.throws(() => parseOverhead(null), /object/);
});

test("parseLimits reads the threshold flags and refuses a value that is not a number", () => {
  assert.deepEqual(parseLimits(["f.json", "--max-view-ms", "8", "--max-interaction-ms", "4"]), {
    maxViewMillis: 8,
    maxInteractionMillis: 4,
  });
  assert.deepEqual(parseLimits(["f.json"]), {});
  assert.throws(() => parseLimits(["--max-view-ms", "x"]), /--max-view-ms/);
});
