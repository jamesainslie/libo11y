import assert from "node:assert/strict";
import { test } from "node:test";
import { type LcpEntry, staleLcpAttribution } from "./lcp.ts";

const nav = { activationStart: 0, responseStart: 40 };
const button: LcpEntry = { element: { id: "button" } as unknown as Element };
const hero: LcpEntry = { element: { id: "hero" } as unknown as Element };
const image: LcpEntry = { element: { id: "img" } as unknown as Element, url: "https://app.test/hero.png" };
const selectors = new Map<unknown, string>([
  [button.element, '[data-o11y="Slow"]'],
  [hero.element, "#hero"],
  [image.element, "#img"],
]);
const targetOf = (e: LcpEntry): string | undefined => (e.element ? selectors.get(e.element) : undefined);
const noResource = (): undefined => undefined;

function reported(entry: LcpEntry, value: number, entries: readonly LcpEntry[]) {
  return {
    value,
    entries,
    attribution: {
      target: targetOf(entry),
      lcpEntry: entry,
      navigationEntry: nav,
      timeToFirstByte: 40,
      resourceLoadDelay: 0,
      resourceLoadDuration: 0,
      elementRenderDelay: value - 40,
    },
  };
}

test("an attribution built from the latest entry is current", () => {
  assert.equal(staleLcpAttribution(reported(hero, 800, [hero]), targetOf, noResource), undefined);
  assert.equal(
    staleLcpAttribution({ value: 0, entries: [], attribution: {} }, targetOf, noResource),
    undefined,
  );
});

test("a later candidate of the same paint gets an attribution of its own", () => {
  // Firefox reports each candidate of one paint, smaller first, at the same render time, so
  // web-vitals sees no change in value and attributes the smaller element.
  const got = staleLcpAttribution(reported(button, 800, [hero]), targetOf, noResource);
  assert.deepEqual(got, {
    target: "#hero",
    lcpEntry: hero,
    navigationEntry: nav,
    timeToFirstByte: 40,
    resourceLoadDelay: 0,
    resourceLoadDuration: 0,
    elementRenderDelay: 760,
  });
});

test("an image candidate's resource timing splits the time after the first byte", () => {
  const resource = { name: image.url ?? "", requestStart: 100, startTime: 90, responseEnd: 300 };
  const got = staleLcpAttribution(reported(button, 800, [image]), targetOf, (url) =>
    url === resource.name ? resource : undefined,
  );
  assert.equal(got?.target, "#img");
  assert.equal(got?.url, image.url);
  assert.equal(got?.lcpResourceEntry, resource);
  assert.equal(got?.timeToFirstByte, 40);
  assert.equal(got?.resourceLoadDelay, 60);
  assert.equal(got?.resourceLoadDuration, 200);
  assert.equal(got?.elementRenderDelay, 500);
});

test("without a navigation entry, all of the value is render delay", () => {
  const m = { value: 800, entries: [hero], attribution: { lcpEntry: button, target: '[data-o11y="Slow"]' } };
  assert.deepEqual(staleLcpAttribution(m, targetOf, noResource), {
    target: "#hero",
    lcpEntry: hero,
    timeToFirstByte: 0,
    resourceLoadDelay: 0,
    resourceLoadDuration: 0,
    elementRenderDelay: 800,
  });
});

test("an element RUM cannot name leaves the target out", () => {
  const unnamed: LcpEntry = { element: null, id: "x" };
  const got = staleLcpAttribution(reported(button, 800, [unnamed]), targetOf, noResource);
  assert.equal(got !== undefined && "target" in got, false);
});
