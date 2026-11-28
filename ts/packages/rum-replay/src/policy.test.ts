import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CSS_ATTRIBUTES,
  FIXED_BLOCK,
  FIXED_MASK,
  KEPT_ATTRIBUTES,
  MASKED_ATTRIBUTES,
  resolvePolicy,
  URL_ATTRIBUTES,
} from "./policy.ts";

test("the fixed rules are always present and the unmask list defaults to empty", () => {
  const p = resolvePolicy(undefined, new Set());
  assert.deepEqual(p.unmask, []);
  for (const s of FIXED_MASK) assert.ok(p.mask.includes(s));
  for (const s of FIXED_BLOCK) assert.ok(p.block.includes(s));
  assert.ok(FIXED_MASK.includes('[contenteditable]:not([contenteditable="false"])'));
  assert.ok(FIXED_BLOCK.includes("[data-o11y-block]"));
});

test("markup alone cannot unmask: [data-o11y-unmask] is honoured only when the code lists it", () => {
  assert.equal(resolvePolicy(undefined, new Set()).unmask.includes("[data-o11y-unmask]"), false);
  assert.equal(resolvePolicy({ mask: [".x"] }, new Set()).unmask.length, 0);
  assert.deepEqual(resolvePolicy({ unmask: ["[data-o11y-unmask]"] }, new Set()).unmask, [
    "[data-o11y-unmask]",
  ]);
});

test("input state, handlers, data attributes and embedded documents are never kept", () => {
  for (const a of [
    "value",
    "checked",
    "selected",
    "srcdoc",
    "onclick",
    "onerror",
    "data-email",
    "rr_dataURL",
    "rr_src",
    "download",
    "action",
    "formaction",
    "background",
    "data",
    "nonce",
    "autocomplete",
    "aria-checked",
    "aria-selected",
  ]) {
    assert.equal(KEPT_ATTRIBUTES.has(a.toLowerCase()), false, a);
    assert.equal(MASKED_ATTRIBUTES.has(a.toLowerCase()), false, a);
    assert.equal(URL_ATTRIBUTES.has(a.toLowerCase()), false, a);
  }
});

test("attributes that carry text follow the text rule; the lists are disjoint and lowercase", () => {
  for (const a of [
    "title",
    "alt",
    "placeholder",
    "aria-label",
    "aria-valuetext",
    "label",
    "content",
    "summary",
  ]) {
    assert.ok(MASKED_ATTRIBUTES.has(a), a);
  }
  for (const a of ["href", "src", "srcset", "xlink:href", "poster"]) assert.ok(URL_ATTRIBUTES.has(a), a);
  for (const a of ["style", "fill", "clip-path"]) assert.ok(CSS_ATTRIBUTES.has(a), a);
  const lists = [KEPT_ATTRIBUTES, MASKED_ATTRIBUTES, URL_ATTRIBUTES, CSS_ATTRIBUTES];
  for (const [i, a] of lists.entries()) {
    for (const name of a) {
      assert.equal(name, name.toLowerCase(), name);
      for (const b of lists.slice(i + 1)) assert.equal(b.has(name), false, name);
    }
  }
});

test("code selectors are added after the fixed ones and invalid input is refused", () => {
  const p = resolvePolicy({ unmask: [".public"], mask: [".secret"], block: [".ad"] }, new Set(["page"]));
  assert.deepEqual(p.unmask, [".public"]);
  assert.deepEqual(p.mask, [...FIXED_MASK, ".secret"]);
  assert.deepEqual(p.block, [...FIXED_BLOCK, ".ad"]);
  assert.ok(p.queryAllowList.has("page"));
  assert.throws(() => resolvePolicy({ unmask: [""] }, new Set()), /INVALID_OPTION|selector/);
  assert.throws(() => resolvePolicy({ mask: ["  "] }, new Set()), /selector/);
  assert.throws(() => resolvePolicy({ block: [3 as unknown as string] }, new Set()), /selector/);
});

test("the policy is frozen", () => {
  const p = resolvePolicy({ unmask: [".public"] }, new Set());
  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.unmask));
  assert.ok(Object.isFrozen(p.mask));
});
