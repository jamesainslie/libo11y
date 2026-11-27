import assert from "node:assert/strict";
import { test } from "node:test";
import { type BudgetFile, compareBudgets, formatTable } from "./size.ts";

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
