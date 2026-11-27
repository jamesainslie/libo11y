import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultViewName } from "./naming.ts";

const name = (s: string) => defaultViewName(new URL(s, "https://app.test"));

test("defaultViewName replaces ID-like segments and drops query and fragment", () => {
  assert.equal(name("/"), "/");
  assert.equal(name("/documents/123/edit?x=1#y"), "/documents/$id/edit");
  assert.equal(name("/users/3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f"), "/users/$id");
  assert.equal(name("/blog/a-very-long-article-slug-that-goes-on"), "/blog/$id");
  assert.equal(name("/settings/profile/"), "/settings/profile/");
});
