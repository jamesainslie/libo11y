import assert from "node:assert/strict";
import { test } from "node:test";
import { privacySignalDenies } from "./privacy-signals.ts";

const BOTH = { respectDoNotTrack: true, respectGlobalPrivacyControl: true };

test("no signal never denies", () => {
  assert.equal(privacySignalDenies(BOTH, undefined), false);
  assert.equal(privacySignalDenies(BOTH, {}), false);
  assert.equal(privacySignalDenies(BOTH, { doNotTrack: null, globalPrivacyControl: false }), false);
  assert.equal(privacySignalDenies(BOTH, { doNotTrack: "0" }), false);
  assert.equal(privacySignalDenies(BOTH, { doNotTrack: "unspecified" }), false);
});

test('Do Not Track denies only when respected and exactly "1"', () => {
  assert.equal(privacySignalDenies({ respectDoNotTrack: true }, { doNotTrack: "1" }), true);
  assert.equal(privacySignalDenies({}, { doNotTrack: "1" }), false);
  assert.equal(privacySignalDenies({ respectDoNotTrack: false }, { doNotTrack: "1" }), false);
  assert.equal(privacySignalDenies({ respectGlobalPrivacyControl: true }, { doNotTrack: "1" }), false);
  assert.equal(privacySignalDenies({ respectDoNotTrack: true }, { doNotTrack: "yes" }), false);
});

test("Global Privacy Control denies only when respected and exactly true", () => {
  assert.equal(
    privacySignalDenies({ respectGlobalPrivacyControl: true }, { globalPrivacyControl: true }),
    true,
  );
  assert.equal(privacySignalDenies({}, { globalPrivacyControl: true }), false);
  assert.equal(privacySignalDenies({ respectDoNotTrack: true }, { globalPrivacyControl: true }), false);
  const truthy = { globalPrivacyControl: "true" } as unknown as { globalPrivacyControl: boolean };
  assert.equal(privacySignalDenies({ respectGlobalPrivacyControl: true }, truthy), false);
});

test("either respected signal is enough", () => {
  assert.equal(privacySignalDenies(BOTH, { doNotTrack: "1", globalPrivacyControl: false }), true);
  assert.equal(privacySignalDenies(BOTH, { doNotTrack: "0", globalPrivacyControl: true }), true);
});

test("a navigator whose getters throw does not deny", () => {
  const hostile = {
    get doNotTrack(): string {
      throw new Error("blocked");
    },
    get globalPrivacyControl(): boolean {
      throw new Error("blocked");
    },
  };
  assert.equal(privacySignalDenies(BOTH, hostile), false);
});
