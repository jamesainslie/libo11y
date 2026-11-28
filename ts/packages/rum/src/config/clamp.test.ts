import assert from "node:assert/strict";
import { test } from "node:test";
import { O11yError } from "@libo11y/core";
import { resolveSettings } from "../settings.ts";
import { clampConfig, parseRemoteConfig, resolveLimits } from "./clamp.ts";

const noop = () => () => {};
const code = resolveSettings({
  sessionSampleRate: 0.2,
  collectors: [
    { name: "views", start: noop },
    { name: "resources", start: noop },
  ],
});
const fixed = resolveLimits(code.sessionSampleRate, undefined);

test("without a document the code settings stand", () => {
  const s = clampConfig(code, undefined, fixed);
  assert.equal(s.sessionSampleRate, 0.2);
  assert.deepEqual([...s.enabled].sort(), ["resources", "views"]);
  assert.equal(s.configVersion, undefined);
  assert.equal(s.enabledByRemote, true);
});

test("without limits the sample rate does not move", () => {
  assert.equal(clampConfig(code, { version: "c1", sessionSampleRate: 1 }, fixed).sessionSampleRate, 0.2);
});

test("within limits it moves and is clamped to them", () => {
  const limits = resolveLimits(0.2, { sessionSampleRate: [0.1, 0.5] });
  assert.equal(clampConfig(code, { version: "c1", sessionSampleRate: 0.05 }, limits).sessionSampleRate, 0.1);
  assert.equal(clampConfig(code, { version: "c1", sessionSampleRate: 0.3 }, limits).sessionSampleRate, 0.3);
  assert.equal(clampConfig(code, { version: "c1", sessionSampleRate: 0.9 }, limits).sessionSampleRate, 0.5);
  assert.equal(clampConfig(code, { version: "c1" }, limits).sessionSampleRate, 0.2);
});

test("collectors can be switched off, never on", () => {
  const s = clampConfig(code, { version: "c1", collectors: { resources: false, errors: true } }, fixed);
  assert.deepEqual([...s.enabled].sort(), ["views"]);
});

test("the version is recorded and enabled:false is the kill switch", () => {
  const s = clampConfig(code, { version: "c9", enabled: false }, fixed);
  assert.equal(s.configVersion, "c9");
  assert.equal(s.enabledByRemote, false);
  assert.equal(clampConfig(code, { version: "c9", enabled: true }, fixed).enabledByRemote, true);
});

test("limits must satisfy 0 <= min <= max <= 1", () => {
  for (const bad of [
    [-0.1, 0.5],
    [0.6, 0.5],
    [0, 1.1],
    [Number.NaN, 1],
  ] as const) {
    assert.throws(
      () => resolveLimits(0.2, { sessionSampleRate: bad }),
      (e: unknown) => e instanceof O11yError && e.code === "INVALID_OPTION",
    );
  }
  assert.deepEqual(resolveLimits(0.2, { sessionSampleRate: [0, 1] }), { sessionSampleRate: [0, 1] });
});

test("parseRemoteConfig reads the gateway body and drops bad fields", () => {
  assert.deepEqual(
    parseRemoteConfig({
      version: "0123456789abcdef",
      config: {
        sessionSampleRate: "x",
        enabled: "yes",
        collectors: { views: "no", errors: false, nope: false },
        extra: 1,
      },
    }),
    { version: "0123456789abcdef", collectors: { errors: false } },
  );
  assert.deepEqual(parseRemoteConfig({ version: "v", config: { enabled: false, sessionSampleRate: 0.5 } }), {
    version: "v",
    enabled: false,
    sessionSampleRate: 0.5,
  });
  assert.deepEqual(parseRemoteConfig({ version: "v", config: { sessionSampleRate: 2 } }), { version: "v" });
});

test("parseRemoteConfig refuses a body without a string version or an object config", () => {
  assert.equal(parseRemoteConfig({ config: { sessionSampleRate: 1 } }), undefined);
  assert.equal(parseRemoteConfig({ version: "", config: {} }), undefined);
  assert.equal(parseRemoteConfig({ version: "v" }), undefined);
  assert.equal(parseRemoteConfig({ version: "v", config: [] }), undefined);
  assert.equal(parseRemoteConfig(null), undefined);
  assert.equal(parseRemoteConfig("v"), undefined);
});

test("the replay object is kept for @libo11y/rum-replay to clamp, and only an object", () => {
  assert.deepEqual(parseRemoteConfig({ version: "v", config: { replay: { mask: [".x"] } } })?.replay, {
    mask: [".x"],
  });
  assert.equal(parseRemoteConfig({ version: "v", config: { replay: [1] } })?.replay, undefined);
  assert.equal(parseRemoteConfig({ version: "v", config: { replay: null } })?.replay, undefined);
  const doc = parseRemoteConfig({ version: "v", config: { replay: { enabled: false } } });
  assert.deepEqual(doc?.replay, { enabled: false });
});

test("remote configuration can switch the replay collector off, never on", () => {
  const withReplay = resolveSettings({ collectors: [{ name: "replay", start: noop }] });
  const doc = parseRemoteConfig({ version: "v", config: { collectors: { replay: false } } });
  assert.deepEqual(doc?.collectors, { replay: false });
  const off = clampConfig(withReplay, doc, resolveLimits(1, undefined));
  assert.equal(off.enabled.has("replay"), false);
  const on = clampConfig(
    code,
    parseRemoteConfig({ version: "v", config: { collectors: { replay: true } } }),
    resolveLimits(0.2, undefined),
  );
  assert.equal(on.enabled.has("replay"), false);
});
