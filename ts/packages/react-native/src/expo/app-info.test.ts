import assert from "node:assert/strict";
import { test } from "node:test";
import { type ExpoModulesLike, expoAppInfoFrom } from "./app-info.ts";

const UPDATE_ID = "0b8c7d9e-1111-4222-8333-444455556666";

const base: ExpoModulesLike = {
  application: { nativeApplicationVersion: "1.0.0" },
  updates: { isEnabled: true, isEmbeddedLaunch: false, updateId: UPDATE_ID },
  device: { deviceType: 1 },
};

test("an over-the-air launch carries the update ID, the app version and the device class", () => {
  assert.deepEqual(expoAppInfoFrom(base), {
    serviceVersion: "1.0.0",
    updateId: UPDATE_ID,
    deviceClass: "mobile",
  });
});

test("the embedded bundle, disabled updates and development carry no update ID", () => {
  const updates = (u: Partial<ExpoModulesLike["updates"]>) =>
    expoAppInfoFrom({ ...base, updates: { ...base.updates, ...u } }).updateId;
  assert.equal(updates({ isEmbeddedLaunch: true }), undefined);
  assert.equal(updates({ isEnabled: false }), undefined);
  assert.equal(updates({ updateId: null }), undefined);
  assert.equal(updates({ updateId: "" }), undefined);
});

test("device types map to device classes, unknown to none", () => {
  const cls = (deviceType: number | null) => expoAppInfoFrom({ ...base, device: { deviceType } }).deviceClass;
  assert.deepEqual(
    [cls(1), cls(2), cls(3), cls(4), cls(0), cls(null), cls(9)],
    ["mobile", "tablet", "desktop", "tv", undefined, undefined, undefined],
  );
});

test("no native version means no service version", () => {
  assert.equal(
    expoAppInfoFrom({ ...base, application: { nativeApplicationVersion: null } }).serviceVersion,
    undefined,
  );
  assert.equal(
    expoAppInfoFrom({ ...base, application: { nativeApplicationVersion: "" } }).serviceVersion,
    undefined,
  );
});

test("a module that throws while read leaves its fields out", () => {
  const throwing = <T extends object>(): T =>
    new Proxy({} as T, {
      get() {
        throw new Error("native module missing");
      },
    });
  assert.deepEqual(expoAppInfoFrom({ application: throwing(), updates: throwing(), device: throwing() }), {});
});
