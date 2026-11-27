import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findSourceMaps } from "./find.ts";

test("pairs scripts with their maps and builds public URLs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets/app-1.js"), "x()\n//# sourceMappingURL=app-1.js.map\n");
  writeFileSync(join(dir, "assets/app-1.js.map"), '{"version":3}');
  writeFileSync(join(dir, "assets/vendor.js"), "y()\n");
  writeFileSync(join(dir, "assets/vendor.js.map"), '{"version":3}');
  writeFileSync(
    join(dir, "assets/inline.js"),
    "z()\n//# sourceMappingURL=data:application/json;base64,e30=\n",
  );
  writeFileSync(join(dir, "assets/nomap.js"), "w()\n");
  writeFileSync(join(dir, "assets/style.css"), "a{}\n/*# sourceMappingURL=style.css.map */\n");
  writeFileSync(join(dir, "assets/style.css.map"), '{"version":3}');
  writeFileSync(join(dir, "index.android.bundle"), "v()\n");
  writeFileSync(join(dir, "index.android.bundle.map"), '{"version":3}');
  const found = await findSourceMaps(dir, "/static/");
  assert.deepEqual(
    found.map((f) => f.url),
    ["/static/assets/app-1.js", "/static/assets/vendor.js", "/static/index.android.bundle"],
  );
  assert.equal(found[0]?.script, join(dir, "assets/app-1.js"));
  assert.equal(found[0]?.map, join(dir, "assets/app-1.js.map"));
});

test("a ~/ prefix maps to the site root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  writeFileSync(join(dir, "app.js"), "x()\n//# sourceMappingURL=app.js.map");
  writeFileSync(join(dir, "app.js.map"), '{"version":3}');
  const found = await findSourceMaps(dir, "~/");
  assert.deepEqual(
    found.map((f) => f.url),
    ["~/app.js"],
  );
  assert.deepEqual(
    (await findSourceMaps(dir, "/")).map((f) => f.url),
    ["/app.js"],
  );
  assert.deepEqual(
    (await findSourceMaps(dir, "https://cdn.example/a")).map((f) => f.url),
    ["https://cdn.example/a/app.js"],
  );
});

test("follows a sourceMappingURL to another name and ignores debugId lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  mkdirSync(join(dir, "maps"));
  writeFileSync(join(dir, "app.js"), "x()\n//# debugId=ABC\n//# sourceMappingURL=maps/app%20one.map?v=1\n");
  writeFileSync(join(dir, "maps/app one.map"), '{"version":3}');
  const found = await findSourceMaps(dir, "/");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.map, join(dir, "maps/app one.map"));
});

test("never reaches outside the directory or into node_modules", async () => {
  const outside = mkdtempSync(join(tmpdir(), "sm-out-"));
  writeFileSync(join(outside, "secret.map"), '{"version":3}');
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  writeFileSync(join(dir, "app.js"), `x()\n//# sourceMappingURL=${join(outside, "secret.map")}\n`);
  writeFileSync(join(dir, "rel.js"), "x()\n//# sourceMappingURL=../../secret.map\n");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules/dep.js"), "x()\n");
  writeFileSync(join(dir, "node_modules/dep.js.map"), '{"version":3}');
  assert.deepEqual(await findSourceMaps(dir, "/"), []);
});
