import assert from "node:assert/strict";
import { test } from "node:test";
import { stripQuery } from "./query.ts";

test("stripQuery keeps only allowed parameters and drops the fragment", () => {
  const allow = new Set(["page"]);
  assert.equal(stripQuery("https://a.test/p?page=2&token=x#frag", allow), "https://a.test/p?page=2");
  assert.equal(stripQuery("https://a.test/p?token=x", allow), "https://a.test/p");
  assert.equal(stripQuery("https://a.test/p", allow), "https://a.test/p");
  assert.equal(stripQuery("not a url", allow), "not a url");
});
