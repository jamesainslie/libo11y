import assert from "node:assert/strict";
import { test } from "node:test";
import { manualTimers } from "../test-support/manual-timers.ts";
import { createFrustrationDetector } from "./detect.ts";

function setup() {
  const c = manualTimers();
  const got: string[] = [];
  const d = createFrustrationDetector({
    timers: c.timers,
    onSignal: (t, s, at) => got.push(`${t} ${s} ${at}`),
  });
  return { c, got, d };
}

test("three clicks on one element within a second are one rage signal, on the third", () => {
  const { c, got, d } = setup();
  for (const at of [0, 200, 400, 600]) {
    c.advance(at - c.now());
    d.click("#save", at, false);
  }
  assert.deepEqual(got, ["rage #save 400"]);
});

test("a click more than a second after the previous one starts a new burst", () => {
  const { got, d } = setup();
  for (const at of [0, 200, 400, 1500, 1700, 1900]) d.click("#save", at, false);
  assert.deepEqual(got, ["rage #save 400", "rage #save 1900"]);
});

test("clicks spread over more than a second are not rage", () => {
  const { got, d } = setup();
  for (const at of [0, 600, 1200, 1800]) d.click("#save", at, false);
  assert.deepEqual(got, []);
});

test("clicks on different elements are not rage", () => {
  const { got, d } = setup();
  d.click("#a", 0, false);
  d.click("#b", 100, false);
  d.click("#a", 200, false);
  assert.deepEqual(got, []);
});

test("a click with no activity within a second is dead", () => {
  const { c, got, d } = setup();
  d.click("#nothing", 0, true);
  c.advance(999);
  assert.deepEqual(got, []);
  c.advance(1);
  assert.deepEqual(got, ["dead #nothing 0"]);
});

test("activity after a click saves it from being dead", () => {
  const { c, got, d } = setup();
  d.click("#ok", 0, true);
  c.advance(300);
  d.activity(300);
  c.advance(1000);
  assert.deepEqual(got, []);
});

test("activity before a click does not save it", () => {
  const { c, got, d } = setup();
  c.advance(100);
  d.click("#late", 100, true);
  d.activity(50);
  c.advance(1000);
  assert.deepEqual(got, ["dead #late 100"]);
});

test("an ineligible click is never dead", () => {
  const { c, got, d } = setup();
  d.click("input", 0, false);
  c.advance(2000);
  assert.deepEqual(got, []);
});

test("an error within a second of a click is an error click, once", () => {
  const { c, got, d } = setup();
  d.click("#go", 0, false);
  c.advance(500);
  d.error(500);
  d.error(600);
  assert.deepEqual(got, ["error #go 500"]);
});

test("an error more than a second after the click is not an error click, unless its action is open", () => {
  const { got, d } = setup();
  d.click("#go", 0, false);
  d.error(1500);
  assert.deepEqual(got, []);
  d.error(1600, true);
  assert.deepEqual(got, ["error #go 1600"]);
});

test("an error with no click before it is not an error click", () => {
  const { got, d } = setup();
  d.error(10, true);
  assert.deepEqual(got, []);
});

test("stop cancels pending dead clicks", () => {
  const { c, got, d } = setup();
  d.click("#nothing", 0, true);
  d.stop();
  c.advance(2000);
  assert.deepEqual(got, []);
  assert.equal(c.pending(), 0);
});
