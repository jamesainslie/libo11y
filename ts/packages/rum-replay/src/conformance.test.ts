/**
 * Runs the shared replay vectors in conformance/rum-replay, which the gateway's Go scrubber runs
 * too. conformance/rum-replay/README.md describes the format.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { stripCssUrls } from "./css.ts";
import { maskText } from "./mask.ts";
import { resolvePolicy } from "./policy.ts";
import { type RrwebEvent, type ScrubContext, scrubEvent } from "./scrub.ts";
import { stripSrcset, stripUrl } from "./urls.ts";

const dir = new URL("../../../../conformance/rum-replay/", import.meta.url);
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, dir), "utf8")) as T;

interface ScrubVector {
  readonly description: string;
  readonly query_allow_list: readonly string[];
  readonly text_allowed_ids: readonly number[];
  readonly editable_ids: readonly number[];
  readonly blocked_ids: readonly number[];
  readonly parent_tags: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
  readonly allowed_texts: readonly string[];
  readonly events: readonly RrwebEvent[];
  readonly expected: readonly RrwebEvent[];
}

test("mask-text vectors", () => {
  const cases = read<{ cases: { in: string; out: string }[] }>("mask-text.json").cases;
  assert.ok(cases.length > 0);
  for (const c of cases) assert.equal(maskText(c.in), c.out, JSON.stringify(c.in));
});

test("url, srcset and css vectors", () => {
  const v = read<{ allow: string[]; cases: { kind: "url" | "srcset" | "css"; in: string; out: string }[] }>(
    "urls.json",
  );
  const allow = new Set(v.allow);
  const strip = { url: stripUrl, srcset: stripSrcset, css: stripCssUrls };
  for (const kind of ["url", "srcset", "css"] as const)
    assert.ok(
      v.cases.some((c) => c.kind === kind),
      kind,
    );
  for (const c of v.cases)
    assert.equal(strip[c.kind](c.in, allow), c.out, `${c.kind} ${JSON.stringify(c.in)}`);
});

const scrubFiles = readdirSync(dir)
  .filter((f) => f.startsWith("scrub-") && f.endsWith(".json"))
  .sort();

test("there are scrub vectors", () => {
  assert.ok(scrubFiles.length >= 8, scrubFiles.join(", "));
});

function run(v: ScrubVector, allowedIds: ReadonlySet<number>): RrwebEvent[] {
  const policy = resolvePolicy(undefined, new Set(v.query_allow_list));
  const editable = new Set(v.editable_ids);
  const blocked = new Set(v.blocked_ids);
  const ctx: ScrubContext = {
    textAllowed: (id) => allowedIds.has(id),
    parentTag: (id) => v.parent_tags[String(id)],
    editable: (id) => editable.has(id),
    blocked: (id) => blocked.has(id),
  };
  return v.events.map((e) => scrubEvent(e, policy, ctx)).filter((e) => e !== undefined);
}

for (const file of scrubFiles) {
  test(`scrub vector ${file} (trust mode: the client's text decisions)`, () => {
    const v = read<ScrubVector>(file);
    assert.ok(v.description !== "" && v.secrets.length > 0, `${file} needs a description and secrets`);
    const raw = JSON.stringify(v.events);
    for (const secret of v.secrets)
      assert.ok(raw.includes(secret), `${file}: secret ${secret} is not in the input`);
    const got = run(v, new Set(v.text_allowed_ids));
    assert.deepEqual(got, v.expected);
    const text = JSON.stringify(got);
    for (const secret of v.secrets) assert.equal(text.includes(secret), false, `${file} leaks ${secret}`);
  });

  test(`scrub vector ${file} (strict mode: no text allowed)`, () => {
    const v = read<ScrubVector>(file);
    const text = JSON.stringify(run(v, new Set()));
    for (const secret of [...v.secrets, ...v.allowed_texts]) {
      assert.equal(text.includes(secret), false, `${file} leaks ${secret} in strict mode`);
    }
  });
}
