/** Retry-After parsing and the full-jitter backoff. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffDelay, parseRetryAfter, RETRYABLE_STATUSES } from "./retry.ts";

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

test("Retry-After in delta-seconds is milliseconds", () => {
  assert.equal(parseRetryAfter("1", NOW), 1000);
  assert.equal(parseRetryAfter("0", NOW), 0);
  assert.equal(parseRetryAfter(" 120 ", NOW), 120_000);
});

test("Retry-After as an HTTP-date is the time until it", () => {
  const at = new Date(NOW + 30_000).toUTCString();
  assert.equal(parseRetryAfter(at, NOW), 30_000);
});

test("a Retry-After date in the past is 0", () => {
  assert.equal(parseRetryAfter(new Date(NOW - 60_000).toUTCString(), NOW), 0);
});

test("missing, negative and garbage Retry-After values are undefined", () => {
  for (const v of [undefined, null, "", "   ", "-1", "1.5", "soon", "12abc", "Infinity"]) {
    assert.equal(parseRetryAfter(v, NOW), undefined, String(v));
  }
});

test("backoff doubles per attempt up to the cap, scaled by random", () => {
  const one = () => 1;
  assert.equal(backoffDelay(1, 1000, 300_000, one), 1000);
  assert.equal(backoffDelay(2, 1000, 300_000, one), 2000);
  assert.equal(backoffDelay(4, 1000, 300_000, one), 8000);
  assert.equal(backoffDelay(30, 1000, 300_000, one), 300_000);
  assert.equal(backoffDelay(5000, 1000, 300_000, one), 300_000);
});

test("backoff is full jitter over the cap", () => {
  assert.equal(
    backoffDelay(3, 1000, 300_000, () => 0.5),
    2000,
  );
  assert.equal(
    backoffDelay(3, 1000, 300_000, () => 0),
    0,
  );
  assert.equal(
    backoffDelay(0, 1000, 300_000, () => 1),
    1000,
  );
});

test("the retryable statuses are the OTLP ones", () => {
  assert.deepEqual([...RETRYABLE_STATUSES].sort(), [408, 429, 502, 503, 504]);
});
