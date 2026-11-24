/**
 * pathMatch is Go's path.Match: these are the vectors of Go's own path/match_test.go, so
 * ignorePaths globs behave as o11yhttp.WithIgnorePaths does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BadPatternError, matchesAny, pathMatch } from "./glob.ts";

const BAD = "bad";

// [pattern, name, matched or "bad"], copied from Go's path/match_test.go.
const GO_VECTORS: readonly (readonly [string, string, boolean | typeof BAD])[] = [
  ["abc", "abc", true],
  ["*", "abc", true],
  ["*c", "abc", true],
  ["a*", "a", true],
  ["a*", "abc", true],
  ["a*", "ab/c", false],
  ["a*/b", "abc/b", true],
  ["a*/b", "a/c/b", false],
  ["a*b*c*d*e*/f", "axbxcxdxe/f", true],
  ["a*b*c*d*e*/f", "axbxcxdxexxx/f", true],
  ["a*b*c*d*e*/f", "axbxcxdxe/xxx/f", false],
  ["a*b*c*d*e*/f", "axbxcxdxexxx/fff", false],
  ["a*b?c*x", "abxbbxdbxebxczzx", true],
  ["a*b?c*x", "abxbbxdbxebxczzy", false],
  ["ab[c]", "abc", true],
  ["ab[b-d]", "abc", true],
  ["ab[e-g]", "abc", false],
  ["ab[^c]", "abc", false],
  ["ab[^b-d]", "abc", false],
  ["ab[^e-g]", "abc", true],
  ["a\\*b", "a*b", true],
  ["a\\*b", "ab", false],
  ["a?b", "a☺b", true],
  ["a[^a]b", "a☺b", true],
  ["a???b", "a☺b", false],
  ["a[^a][^a][^a]b", "a☺b", false],
  ["[a-ζ]*", "α", true],
  ["*[a-ζ]", "A", false],
  ["a?b", "a/b", false],
  ["a*b", "a/b", false],
  ["[\\]a]", "]", true],
  ["[\\-]", "-", true],
  ["[x\\-]", "x", true],
  ["[x\\-]", "-", true],
  ["[x\\-]", "z", false],
  ["[\\-x]", "x", true],
  ["[\\-x]", "-", true],
  ["[\\-x]", "a", false],
  ["[]a]", "]", BAD],
  ["[-]", "-", BAD],
  ["[x-]", "x", BAD],
  ["[x-]", "-", BAD],
  ["[x-]", "z", BAD],
  ["[-x]", "x", BAD],
  ["[-x]", "-", BAD],
  ["[-x]", "a", BAD],
  ["\\", "a", BAD],
  ["[a-b-c]", "a", BAD],
  ["[", "a", BAD],
  ["[^", "a", BAD],
  ["[^bc", "a", BAD],
  ["a[", "a", BAD],
  ["a[", "ab", BAD],
  ["a[", "x", BAD],
  ["a/b[", "x", BAD],
  ["*x", "xxx", true],
];

test("pathMatch agrees with Go's path.Match on every vector of its test suite", () => {
  for (const [pattern, name, want] of GO_VECTORS) {
    if (want === BAD) {
      assert.throws(() => pathMatch(pattern, name), BadPatternError, `${pattern} on ${name}`);
    } else {
      assert.equal(pathMatch(pattern, name), want, `${pattern} on ${name}`);
    }
  }
});

test("matchesAny matches URL paths and treats a malformed pattern as never matching", () => {
  assert.equal(matchesAny(["/healthz"], "/healthz"), true);
  assert.equal(matchesAny(["/debug/*"], "/debug/pprof"), true);
  assert.equal(matchesAny(["/debug/*"], "/debug/pprof/heap"), false);
  assert.equal(matchesAny(["/static/*.css"], "/static/site.css"), true);
  assert.equal(matchesAny(["[", "/ready"], "/ready"), true);
  assert.equal(matchesAny(["/a["], "/a["), false);
  assert.equal(matchesAny([], "/"), false);
});
