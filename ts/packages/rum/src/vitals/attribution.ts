/**
 * Vital values and attribution in the spec's units (spec 1.3.0, registry.o11y.rum.detail).
 * web-vitals reports milliseconds; the spec records seconds, and CLS has no unit. Attribution
 * fields map to o11y.rum.vital.attribution.* and the element to o11y.rum.element.selector. A field
 * that is missing, not finite, empty or outside its enum is left out. No rating is ever produced:
 * the gateway rates each vital.
 */
import {
  ATTR_RUM_ELEMENT_SELECTOR,
  ATTR_RUM_VITAL_ATTRIBUTION_ELEMENT_RENDER_DELAY,
  ATTR_RUM_VITAL_ATTRIBUTION_INPUT_DELAY,
  ATTR_RUM_VITAL_ATTRIBUTION_INTERACTION_TYPE,
  ATTR_RUM_VITAL_ATTRIBUTION_LARGEST_SHIFT_TIME,
  ATTR_RUM_VITAL_ATTRIBUTION_LARGEST_SHIFT_VALUE,
  ATTR_RUM_VITAL_ATTRIBUTION_LOAD_STATE,
  ATTR_RUM_VITAL_ATTRIBUTION_PRESENTATION_DELAY,
  ATTR_RUM_VITAL_ATTRIBUTION_PROCESSING_DURATION,
  ATTR_RUM_VITAL_ATTRIBUTION_RESOURCE_LOAD_DELAY,
  ATTR_RUM_VITAL_ATTRIBUTION_RESOURCE_LOAD_DURATION,
  ATTR_RUM_VITAL_ATTRIBUTION_TIME_TO_FIRST_BYTE,
  RUM_VITAL_ATTRIBUTION_INTERACTION_TYPE_VALUES,
  RUM_VITAL_ATTRIBUTION_LOAD_STATE_VALUES,
} from "@libo11y/spec";
import type { VitalName } from "../contracts/summary.ts";

/** One web-vitals report, reduced to what RUM reads. Times are milliseconds. */
export interface VitalMetric {
  readonly name: "LCP" | "INP" | "CLS" | "FCP" | "TTFB";
  readonly value: number;
  readonly delta: number;
  readonly id: string;
  readonly navigationType: string;
  readonly attribution: Readonly<Record<string, unknown>>;
}

const MAX_SELECTOR = 200;

/** The metric's value in the spec's unit: seconds for lcp, inp, fcp and ttfb, unitless for cls. */
export function vitalValue(name: VitalName, valueMillisOrScore: number): number {
  return name === "cls" ? valueMillisOrScore : valueMillisOrScore / 1000;
}

type Kind = "ms" | "score" | "selector" | readonly string[];
type Field = readonly [source: string, attr: string, kind: Kind];

const FIELDS: Readonly<Record<VitalMetric["name"], readonly Field[]>> = {
  LCP: [
    ["target", ATTR_RUM_ELEMENT_SELECTOR, "selector"],
    ["timeToFirstByte", ATTR_RUM_VITAL_ATTRIBUTION_TIME_TO_FIRST_BYTE, "ms"],
    ["resourceLoadDelay", ATTR_RUM_VITAL_ATTRIBUTION_RESOURCE_LOAD_DELAY, "ms"],
    ["resourceLoadDuration", ATTR_RUM_VITAL_ATTRIBUTION_RESOURCE_LOAD_DURATION, "ms"],
    ["elementRenderDelay", ATTR_RUM_VITAL_ATTRIBUTION_ELEMENT_RENDER_DELAY, "ms"],
  ],
  INP: [
    ["interactionTarget", ATTR_RUM_ELEMENT_SELECTOR, "selector"],
    [
      "interactionType",
      ATTR_RUM_VITAL_ATTRIBUTION_INTERACTION_TYPE,
      RUM_VITAL_ATTRIBUTION_INTERACTION_TYPE_VALUES,
    ],
    ["inputDelay", ATTR_RUM_VITAL_ATTRIBUTION_INPUT_DELAY, "ms"],
    ["processingDuration", ATTR_RUM_VITAL_ATTRIBUTION_PROCESSING_DURATION, "ms"],
    ["presentationDelay", ATTR_RUM_VITAL_ATTRIBUTION_PRESENTATION_DELAY, "ms"],
    ["loadState", ATTR_RUM_VITAL_ATTRIBUTION_LOAD_STATE, RUM_VITAL_ATTRIBUTION_LOAD_STATE_VALUES],
  ],
  CLS: [
    ["largestShiftTarget", ATTR_RUM_ELEMENT_SELECTOR, "selector"],
    ["largestShiftValue", ATTR_RUM_VITAL_ATTRIBUTION_LARGEST_SHIFT_VALUE, "score"],
    ["largestShiftTime", ATTR_RUM_VITAL_ATTRIBUTION_LARGEST_SHIFT_TIME, "ms"],
    ["loadState", ATTR_RUM_VITAL_ATTRIBUTION_LOAD_STATE, RUM_VITAL_ATTRIBUTION_LOAD_STATE_VALUES],
  ],
  FCP: [["timeToFirstByte", ATTR_RUM_VITAL_ATTRIBUTION_TIME_TO_FIRST_BYTE, "ms"]],
  TTFB: [],
};

/** The attribution attributes and o11y.rum.element.selector for one web-vitals report. */
export function attributionAttributes(metric: VitalMetric): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [source, attr, kind] of FIELDS[metric.name]) {
    const v = metric.attribution[source];
    if (kind === "ms" || kind === "score") {
      if (typeof v === "number" && Number.isFinite(v)) out[attr] = kind === "ms" ? v / 1000 : v;
    } else if (typeof v === "string" && v !== "") {
      if (kind === "selector") out[attr] = v.slice(0, MAX_SELECTOR);
      else if (kind.includes(v)) out[attr] = v;
    }
  }
  return out;
}
