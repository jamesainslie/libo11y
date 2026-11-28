import assert from "node:assert/strict";
import { test } from "node:test";
import { attributionAttributes, type VitalMetric, vitalValue } from "./attribution.ts";

const metric = (name: VitalMetric["name"], attribution: Record<string, unknown>): VitalMetric => ({
  name,
  value: 1,
  delta: 1,
  id: "v5-1",
  navigationType: "navigate",
  attribution,
});

test("vitalValue converts milliseconds to seconds, except CLS", () => {
  assert.equal(vitalValue("lcp", 2500), 2.5);
  assert.equal(vitalValue("ttfb", 300), 0.3);
  assert.equal(vitalValue("cls", 0.12), 0.12);
});

test("INP attribution maps phases to seconds and the target to the selector", () => {
  assert.deepEqual(
    attributionAttributes(
      metric("INP", {
        interactionTarget: "#save",
        interactionType: "pointer",
        inputDelay: 12,
        processingDuration: 180,
        presentationDelay: 48,
        loadState: "complete",
      }),
    ),
    {
      "o11y.rum.element.selector": "#save",
      "o11y.rum.vital.attribution.interaction_type": "pointer",
      "o11y.rum.vital.attribution.input_delay": 0.012,
      "o11y.rum.vital.attribution.processing_duration": 0.18,
      "o11y.rum.vital.attribution.presentation_delay": 0.048,
      "o11y.rum.vital.attribution.load_state": "complete",
    },
  );
});

test("LCP attribution", () => {
  assert.deepEqual(
    attributionAttributes(
      metric("LCP", {
        target: "img.hero",
        url: "https://cdn.test/hero.png?user=7",
        timeToFirstByte: 300,
        resourceLoadDelay: 200,
        resourceLoadDuration: 900,
        elementRenderDelay: 400,
      }),
    ),
    {
      "o11y.rum.element.selector": "img.hero",
      "o11y.rum.vital.attribution.time_to_first_byte": 0.3,
      "o11y.rum.vital.attribution.resource_load_delay": 0.2,
      "o11y.rum.vital.attribution.resource_load_duration": 0.9,
      "o11y.rum.vital.attribution.element_render_delay": 0.4,
    },
  );
});

test("CLS attribution", () => {
  assert.deepEqual(
    attributionAttributes(
      metric("CLS", {
        largestShiftTarget: "div.ad",
        largestShiftValue: 0.15,
        largestShiftTime: 2400,
        loadState: "dom-content-loaded",
      }),
    ),
    {
      "o11y.rum.element.selector": "div.ad",
      "o11y.rum.vital.attribution.largest_shift_value": 0.15,
      "o11y.rum.vital.attribution.largest_shift_time": 2.4,
      "o11y.rum.vital.attribution.load_state": "dom-content-loaded",
    },
  );
});

test("FCP attribution carries the time to first byte", () => {
  assert.deepEqual(attributionAttributes(metric("FCP", { timeToFirstByte: 250, firstByteToFCP: 400 })), {
    "o11y.rum.vital.attribution.time_to_first_byte": 0.25,
  });
});

test("missing, unknown and out-of-enum attribution fields are left out", () => {
  assert.deepEqual(attributionAttributes(metric("TTFB", { waitingDuration: 10 })), {});
  assert.deepEqual(
    attributionAttributes(
      metric("INP", {
        interactionTarget: "",
        interactionType: "touch",
        inputDelay: Number.NaN,
        loadState: "prerendering",
      }),
    ),
    {},
  );
});

test("a long selector is cut to 200 characters", () => {
  const a = attributionAttributes(metric("LCP", { target: "x".repeat(300) }));
  assert.equal(String(a["o11y.rum.element.selector"]).length, 200);
});
