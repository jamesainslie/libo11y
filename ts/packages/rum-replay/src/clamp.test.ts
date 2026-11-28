import assert from "node:assert/strict";
import { test } from "node:test";
import { clampReplay, parseReplayRemote, type ReplaySettings, resolveReplayLimits } from "./clamp.ts";
import { FIXED_BLOCK, FIXED_MASK, resolvePolicy } from "./policy.ts";

const code: ReplaySettings = {
  enabled: true,
  sampleRate: 0.5,
  onRetain: true,
  policy: resolvePolicy({ unmask: [".public", ".nav"], mask: [".price"] }, new Set(["page"])),
};
const any = (): boolean => true;
const fixed: readonly [number, number] = [0.5, 0.5];

test("no remote document leaves the code settings as they are", () => {
  assert.deepEqual(clampReplay(code, fixed, undefined), code);
});

test("remote can never unmask: unmask is intersected with the code list", () => {
  const s = clampReplay(code, fixed, parseReplayRemote({ unmask: [".nav", ".everything", "*"] }, any));
  assert.deepEqual(s.policy.unmask, [".nav"]);
  assert.deepEqual(clampReplay(code, fixed, parseReplayRemote({ unmask: [] }, any)).policy.unmask, []);
  const none = { ...code, policy: resolvePolicy(undefined, new Set()) };
  assert.deepEqual(
    clampReplay(none, fixed, parseReplayRemote({ unmask: ["*", "body"] }, any)).policy.unmask,
    [],
  );
});

test("remote can add mask and block selectors and never remove the fixed or code ones", () => {
  const s = clampReplay(
    code,
    fixed,
    parseReplayRemote({ mask: [".total", ".price"], block: [".chat"] }, any),
  );
  assert.deepEqual(s.policy.mask, [...FIXED_MASK, ".price", ".total"]);
  assert.deepEqual(s.policy.block, [...FIXED_BLOCK, ".chat"]);
  const empty = clampReplay(code, fixed, parseReplayRemote({ mask: [], block: [] }, any));
  assert.deepEqual(empty.policy.mask, code.policy.mask);
  assert.deepEqual(empty.policy.block, code.policy.block);
});

test("remote can switch replay and onRetain off, never on", () => {
  assert.equal(clampReplay(code, fixed, parseReplayRemote({ enabled: false }, any)).enabled, false);
  assert.equal(parseReplayRemote({ enabled: true }, any)?.enabled, undefined);
  const off = { ...code, enabled: false, onRetain: false };
  const s = clampReplay(off, fixed, parseReplayRemote({ enabled: true, onRetain: true }, any));
  assert.equal(s.enabled, false);
  assert.equal(s.onRetain, false);
  assert.equal(clampReplay(code, fixed, parseReplayRemote({ onRetain: false }, any)).onRetain, false);
  assert.equal(clampReplay(code, fixed, parseReplayRemote({ enabled: "false" }, any)).enabled, true);
});

test("the sample rate moves only within code limits", () => {
  assert.equal(clampReplay(code, fixed, parseReplayRemote({ sampleRate: 1 }, any)).sampleRate, 0.5);
  assert.equal(clampReplay(code, fixed, parseReplayRemote({ sampleRate: 0 }, any)).sampleRate, 0.5);
  assert.equal(clampReplay(code, [0.1, 0.8], parseReplayRemote({ sampleRate: 0.7 }, any)).sampleRate, 0.5);
  assert.equal(clampReplay(code, [0.1, 0.8], parseReplayRemote({ sampleRate: 0 }, any)).sampleRate, 0.1);
  assert.equal(clampReplay(code, [0, 0.5], parseReplayRemote({ sampleRate: 0 }, any)).sampleRate, 0);
});

test("a sample rate outside 0 to 1 or not a number is ignored", () => {
  for (const sampleRate of [-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0.1", null]) {
    assert.equal(parseReplayRemote({ sampleRate }, any)?.sampleRate, undefined, String(sampleRate));
  }
});

test("invalid selectors and unknown fields are dropped", () => {
  const r = parseReplayRemote(
    { mask: ["::bad", ".ok", 3, "", "  "], sampleRate: "x", extra: true },
    (s) => s !== "::bad",
  );
  assert.deepEqual(r, { mask: [".ok"] });
  assert.equal(parseReplayRemote("nope", any), undefined);
  assert.equal(parseReplayRemote(null, any), undefined);
  assert.equal(parseReplayRemote([{ enabled: false }], any), undefined);
  assert.deepEqual(parseReplayRemote({ block: "not-a-list", unmask: { a: 1 } }, any), {});
});

test("a selector the validator throws on is dropped", () => {
  const r = parseReplayRemote({ block: [".a", ".b"] }, (s) => {
    if (s === ".b") throw new Error("boom");
    return true;
  });
  assert.deepEqual(r, { block: [".a"] });
});

test("the clamped settings are frozen", () => {
  const s = clampReplay(code, fixed, parseReplayRemote({ mask: [".x"] }, any));
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.isFrozen(s.policy));
  assert.ok(Object.isFrozen(s.policy.mask));
  assert.equal(s.policy.queryAllowList, code.policy.queryAllowList);
});

test("code limits default to no change and must satisfy 0 <= min <= max <= 1", () => {
  assert.deepEqual(resolveReplayLimits(0.3, undefined), [0.3, 0.3]);
  assert.deepEqual(resolveReplayLimits(0.3, { sampleRate: [0.1, 0.9] }), [0.1, 0.9]);
  for (const bad of [
    [-0.1, 0.5],
    [0.6, 0.5],
    [0, 1.1],
    [Number.NaN, 1],
  ] as const) {
    assert.throws(() => resolveReplayLimits(0.3, { sampleRate: bad }), /INVALID_OPTION|limits/);
  }
});

test("remote can only lower the sample rate: never above the code rate, whatever the limits", () => {
  assert.equal(clampReplay(code, [0.1, 0.8], parseReplayRemote({ sampleRate: 1 }, any)).sampleRate, 0.5);
  assert.equal(clampReplay(code, [0.1, 0.8], parseReplayRemote({ sampleRate: 0.3 }, any)).sampleRate, 0.3);
});

test("a code rate outside its own limits is refused", () => {
  assert.throws(() => resolveReplayLimits(0.1, { sampleRate: [0.5, 1] }), /INVALID_OPTION|limits/);
  assert.throws(() => resolveReplayLimits(0.9, { sampleRate: [0, 0.5] }), /INVALID_OPTION|limits/);
});
