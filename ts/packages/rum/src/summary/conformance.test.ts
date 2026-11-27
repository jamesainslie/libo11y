import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SummaryCountKey, SummaryView, VitalName } from "../contracts/summary.ts";
import { createSummaryAccumulator } from "./accumulator.ts";

const DIR = fileURLToPath(new URL("../../../../../conformance/rum-summary/", import.meta.url));

type Step =
  | { at: number; do: "open"; view: SummaryView }
  | { at: number; do: "close"; viewId: string }
  | { at: number; do: "count"; key: SummaryCountKey; n?: number }
  | { at: number; do: "vital"; viewId: string; name: VitalName; value: number }
  | { at: number; do: "hide" | "show" | "flush" };

interface Vector {
  readonly description: string;
  readonly platform: "web";
  readonly steps: Step[];
  readonly want: Record<string, string | number>[];
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

test("the rum-summary vectors exist", () => {
  assert.ok(files.length >= 6, `found ${files.length}`);
});

for (const file of files) {
  const v = JSON.parse(readFileSync(DIR + file, "utf8")) as Vector;
  test(`rum-summary ${file}: ${v.description}`, () => {
    let t = 0;
    let visible = true;
    const got: Record<string, string | number>[] = [];
    const acc = createSummaryAccumulator({
      platform: v.platform,
      emit: (a) => got.push(a),
      now: () => t,
      visible: () => visible,
    });
    for (const s of v.steps) {
      t = s.at;
      if (s.do === "open") acc.open(s.view);
      else if (s.do === "close") acc.close(s.viewId);
      else if (s.do === "count") acc.count(s.key, s.n);
      else if (s.do === "vital") acc.vital(s.viewId, s.name, s.value);
      else if (s.do === "hide") {
        visible = false;
        acc.visibility(false);
        acc.flush();
      } else if (s.do === "show") {
        visible = true;
        acc.visibility(true);
      } else acc.flush();
    }
    assert.equal(got.length, v.want.length, JSON.stringify(got));
    got.forEach((g, i) => {
      const w = v.want[i] ?? {};
      assert.deepEqual(Object.keys(g).sort(), Object.keys(w).sort(), `record ${i}`);
      for (const [k, wv] of Object.entries(w)) {
        const gv = g[k];
        if (typeof wv === "number" && typeof gv === "number") {
          assert.ok(Math.abs(gv - wv) < 1e-9, `record ${i} ${k}: ${gv} != ${wv}`);
        } else assert.equal(gv, wv, `record ${i} ${k}`);
      }
    });
  });
}
