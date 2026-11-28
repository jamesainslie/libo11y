import assert from "node:assert/strict";
import { test } from "node:test";
import { type BudgetFile, buildOptions, compareBudgets, formatTable, splitSizes } from "./size.ts";

const FILE: BudgetFile = {
  unit: "bytes",
  entries: { base: { code: "a", budget: 100 } },
  deltas: { extra: { base: "base", code: "b", budget: 10 } },
};

test("compareBudgets reports sizes, deltas and every overrun", () => {
  const rows = compareBudgets(FILE, { base: 90, extra: 104 });
  assert.deepEqual(rows, [
    { name: "base", size: 90, budget: 100, over: false },
    { name: "extra", size: 14, budget: 10, over: true },
  ]);
});

test("compareBudgets refuses a missing measurement or an unknown delta base", () => {
  assert.throws(() => compareBudgets(FILE, { base: 90 }), /extra/);
  assert.throws(
    () =>
      compareBudgets(
        { unit: "bytes", entries: {}, deltas: { d: { base: "nope", code: "c", budget: 1 } } },
        { d: 1 },
      ),
    /nope/,
  );
});

test("formatTable renders a markdown table", () => {
  const md = formatTable([
    { name: "base", size: 90, budget: 100, over: false },
    { name: "extra", size: 14, budget: 10, over: true },
  ]);
  assert.match(md, /\| base \| 90 \| 100 \| ok \|/);
  assert.match(md, /\| extra \| 14 \| 10 \| over \|/);
});

test("buildOptions bundles for the browser and keeps an entry's externals out of the bundle", () => {
  const plain = buildOptions("/tmp/a.ts", undefined);
  assert.deepEqual(plain.entrypoints, ["/tmp/a.ts"]);
  assert.equal(plain.target, "browser");
  assert.equal(plain.minify, true);
  assert.equal("external" in plain, false);
  assert.deepEqual(buildOptions("/tmp/a.ts", ["react"]).external, ["react"]);
  assert.equal("conditions" in plain, false);
  assert.equal(plain.splitting, false);
  assert.equal(buildOptions("/tmp/a.ts", undefined, undefined, true).splitting, true);
});

test("splitSizes counts the entry and what it imports statically as initial, the rest as lazy", () => {
  const sizes = splitSizes([
    {
      path: "./m.js",
      kind: "entry-point",
      code: 'import{a as x}from"./chunk-shim.js";import"./chunk-side.js";x(()=>import("./chunk-lazy.js"))',
      size: 100,
    },
    { path: "./chunk-shim.js", kind: "chunk", code: "export{d as a}", size: 5 },
    { path: "./chunk-side.js", kind: "chunk", code: 'import"./chunk-deep.js";', size: 7 },
    { path: "./chunk-deep.js", kind: "chunk", code: "", size: 11 },
    {
      path: "./chunk-lazy.js",
      kind: "chunk",
      code: 'import"./chunk-shim.js";import"./chunk-lazy2.js"',
      size: 40,
    },
    { path: "./chunk-lazy2.js", kind: "chunk", code: "", size: 3 },
  ]);
  assert.deepEqual(sizes, { initial: 123, lazy: 43 });
});

test("splitSizes refuses a build without exactly one entry", () => {
  assert.throws(() => splitSizes([{ path: "./c.js", kind: "chunk", code: "", size: 1 }]), /entry/);
});

test("buildOptions passes an entry's export conditions, as React Native's Metro resolves them", () => {
  const rn = buildOptions("/tmp/a.ts", ["react-native"], ["react-native"]);
  assert.deepEqual(rn.conditions, ["react-native"]);
  assert.deepEqual(rn.external, ["react-native"]);
  assert.equal(rn.target, "browser");
});
