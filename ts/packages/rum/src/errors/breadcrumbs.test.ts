import assert from "node:assert/strict";
import { test } from "node:test";
import { createBreadcrumbs } from "./breadcrumbs.ts";

test("breadcrumbs keep the last max entries, oldest first, with their age", () => {
  const b = createBreadcrumbs(3);
  b.add("view", "/docs/$id", 100);
  b.add("click", "Sign", 400);
  b.add("fetch", "POST api.test 500", 600);
  b.add("click", "Retry", 900);
  assert.deepEqual(b.snapshot(1000), [
    "click Sign -600ms",
    "fetch POST api.test 500 -400ms",
    "click Retry -100ms",
  ]);
});

test("the default keeps 20 and an entry from the future has age 0", () => {
  const b = createBreadcrumbs();
  for (let i = 0; i < 25; i++) b.add("click", `b${i}`, i);
  const got = b.snapshot(10);
  assert.equal(got.length, 20);
  assert.equal(got[0], "click b5 -5ms");
  assert.equal(got.at(-1), "click b24 -0ms");
});

test("a line break in a label never splits one breadcrumb into two lines", () => {
  const b = createBreadcrumbs();
  b.add("click", "a\nb\rc", 0);
  assert.deepEqual(b.snapshot(0), ["click a b c -0ms"]);
});

test("clear empties the ring", () => {
  const b = createBreadcrumbs();
  b.add("click", "x", 0);
  b.clear();
  assert.deepEqual(b.snapshot(5), []);
});
