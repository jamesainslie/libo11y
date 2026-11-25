/**
 * The propagation allow-list and the ignore list.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isIgnored, shouldPropagate } from "./origins.ts";

const PAGE = "https://app.example.com";

test("the page's own origin always receives context", () => {
  assert.equal(shouldPropagate(new URL("https://app.example.com/api/x?q=1"), [], PAGE), true);
});

test("another origin receives nothing by default", () => {
  assert.equal(shouldPropagate(new URL("https://api.example.com/x"), [], PAGE), false);
  assert.equal(shouldPropagate(new URL("http://app.example.com/x"), [], PAGE), false);
  assert.equal(shouldPropagate(new URL("https://app.example.com:8443/x"), [], PAGE), false);
});

test("an exact string matches the origin after normalization", () => {
  const url = new URL("https://api.example.com/v1/items");
  assert.equal(shouldPropagate(url, ["https://api.example.com"], PAGE), true);
  assert.equal(shouldPropagate(url, ["https://API.example.com:443/"], PAGE), true);
  assert.equal(shouldPropagate(url, ["https://api.example.com/v1"], PAGE), true);
  assert.equal(shouldPropagate(url, ["https://example.com"], PAGE), false);
  assert.equal(shouldPropagate(url, ["api.example.com"], PAGE), false);
  assert.equal(shouldPropagate(url, ["not a url"], PAGE), false);
});

test("a RegExp is tested against the origin, not the path", () => {
  const url = new URL("https://eu.api.example.com/v1");
  assert.equal(shouldPropagate(url, [/^https:\/\/[a-z]+\.api\.example\.com$/], PAGE), true);
  assert.equal(shouldPropagate(url, [/\/v1/], PAGE), false);
  const global = /api\.example\.com/g;
  assert.equal(shouldPropagate(url, [global], PAGE), true);
  assert.equal(shouldPropagate(url, [global], PAGE), true, "a global RegExp's lastIndex is not carried over");
});

test("an opaque origin never matches", () => {
  const data = new URL("data:text/plain,hi");
  assert.equal(data.origin, "null");
  assert.equal(shouldPropagate(data, [/.*/, "null"], "null"), false);
});

test("pageOrigin defaults to the global location, and without one only the allow-list counts", () => {
  const url = new URL("https://app.example.com/x");
  const had = Object.hasOwn(globalThis, "location");
  const before = Object.getOwnPropertyDescriptor(globalThis, "location");
  try {
    Object.defineProperty(globalThis, "location", { value: { origin: PAGE }, configurable: true });
    assert.equal(shouldPropagate(url, []), true);
    Object.defineProperty(globalThis, "location", { value: undefined, configurable: true });
    assert.equal(shouldPropagate(url, []), false);
    assert.equal(shouldPropagate(url, [PAGE]), true);
  } finally {
    if (had && before !== undefined) Object.defineProperty(globalThis, "location", before);
    else delete (globalThis as { location?: unknown }).location;
  }
});

test("isIgnored matches a string prefix of the absolute URL or a RegExp", () => {
  const url = new URL("https://collector.example.com/v1/traces?x=1");
  assert.equal(isIgnored(url, []), false);
  assert.equal(isIgnored(url, ["https://collector.example.com/v1/"]), true);
  assert.equal(isIgnored(url, ["https://collector.example.com/v2/"]), false);
  assert.equal(isIgnored(url, ["/v1/traces"]), false);
  assert.equal(isIgnored(url, [/\/v1\/(traces|logs)/]), true);
  assert.equal(isIgnored(url, [/^http:/]), false);
  const global = /collector/g;
  assert.equal(isIgnored(url, [global]), true);
  assert.equal(isIgnored(url, [global]), true);
});
