import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceClassOf } from "./device-class.ts";

const screen = (width: number, height: number) => () => ({ width, height });

test("TV, iPad, large Android screens and phones", () => {
  assert.equal(deviceClassOf({ os: "android", isPad: false, isTV: true, screen: screen(1920, 1080) }), "tv");
  assert.equal(deviceClassOf({ os: "ios", isPad: false, isTV: true, screen: screen(1920, 1080) }), "tv");
  assert.equal(deviceClassOf({ os: "ios", isPad: true, isTV: false, screen: screen(820, 1180) }), "tablet");
  assert.equal(
    deviceClassOf({ os: "android", isPad: false, isTV: false, screen: screen(800, 1280) }),
    "tablet",
  );
  assert.equal(
    deviceClassOf({ os: "android", isPad: false, isTV: false, screen: screen(1280, 600) }),
    "tablet",
  );
  assert.equal(
    deviceClassOf({ os: "android", isPad: false, isTV: false, screen: screen(411, 891) }),
    "mobile",
  );
  assert.equal(deviceClassOf({ os: "ios", isPad: false, isTV: false, screen: screen(1024, 1366) }), "mobile");
  assert.equal(
    deviceClassOf({ os: "android", isPad: false, isTV: false, screen: () => undefined }),
    "mobile",
  );
});

test("a screen that throws or is not a number counts as a phone", () => {
  const throws = () => {
    throw new Error("no Dimensions");
  };
  assert.equal(deviceClassOf({ os: "android", isPad: false, isTV: false, screen: throws }), "mobile");
  assert.equal(
    deviceClassOf({ os: "android", isPad: false, isTV: false, screen: screen(Number.NaN, 900) }),
    "mobile",
  );
});
