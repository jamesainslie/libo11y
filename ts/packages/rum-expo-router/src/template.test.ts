import assert from "node:assert/strict";
import { test } from "node:test";
import { routeTemplate } from "./template.ts";

test("segments join into the route template, groups and placeholders kept", () => {
  assert.equal(routeTemplate(["(studio)", "projects", "[projectId]"]), "/(studio)/projects/[projectId]");
  assert.equal(
    routeTemplate(["(outside)", "work", "projects", "[projectId]", "plan"]),
    "/(outside)/work/projects/[projectId]/plan",
  );
  assert.equal(routeTemplate(["docs", "[...slug]"]), "/docs/[...slug]");
});

test("the root, index routes and the not-found route", () => {
  assert.equal(routeTemplate([]), "/");
  assert.equal(routeTemplate(["(client)"]), "/(client)");
  assert.equal(routeTemplate(["(client)", "index"]), "/(client)");
  assert.equal(routeTemplate(["index"]), "/");
  assert.equal(routeTemplate(["+not-found"]), "/+not-found");
});

test("an index segment that is not the last is a real path segment", () => {
  assert.equal(routeTemplate(["index", "[id]"]), "/index/[id]");
});

test("empty segments are dropped", () => {
  assert.equal(routeTemplate(["", "a", ""]), "/a");
});
