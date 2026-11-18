import { expect, test } from "bun:test";
import {
  ATTR_OUTCOME,
  ATTR_RUM_VIEW_NAME,
  ENVIRONMENT_VALUES,
  EVENT_RUM_ERROR,
  EVENT_TELEMETRY_CONFIGURED,
  EVENTS,
  METRIC_RUM_VITAL_LCP,
  METRIC_SCHEMA_VIOLATIONS,
  OUTCOME_VALUES,
  type Outcome,
  REQUIRED_TIER0,
  RESOURCE,
  RUM_CONNECTION_EFFECTIVE_VALUE_SLOW_2G,
  RUM_CONNECTION_EFFECTIVE_VALUE_TYPE_2G,
  RUM_SPAN_REQUIRED,
  RUM_VIEW_KIND_VALUES,
  RUM_VITAL_RATING_VALUE_NEEDS_IMPROVEMENT,
  SCHEMA_URL,
  SENSITIVITY_OF,
  SPEC_VERSION,
} from "./index";

test("the schema URL names the spec version", () => {
  expect(SCHEMA_URL.endsWith(`/${SPEC_VERSION}`)).toBe(true);
});

test("minted keys and closed enums", () => {
  expect(ATTR_OUTCOME).toBe("o11y.outcome");
  const success: Outcome = "success";
  expect(OUTCOME_VALUES).toContain(success);
  // @ts-expect-error "nope" is not an Outcome, so the union stays closed.
  const notAnOutcome: Outcome = "nope";
  void notAnOutcome;
});

test("tier 0 requires the service identity", () => {
  expect(REQUIRED_TIER0).toContain("service.name");
  expect(RESOURCE.get("o11y.tenant.id")).toEqual({
    tier: "tier3",
    requirement: "opt_in",
    source: "option",
    role: "descriptive",
  });
});

test("the environment set", () => {
  expect([...ENVIRONMENT_VALUES]).toEqual(["production", "staging", "development", "test"]);
});

test("sensitivity lookups never reach the prototype", () => {
  expect(SENSITIVITY_OF.get("o11y.tenant.id")).toBe("internal");
  expect(SENSITIVITY_OF.get("http.request.header.authorization")).toBe("secret");
  expect(SENSITIVITY_OF.get("constructor")).toBeUndefined();
  expect(SENSITIVITY_OF.get("__proto__")).toBeUndefined();
});

test("event contracts and metric names", () => {
  expect(EVENTS.get(EVENT_TELEMETRY_CONFIGURED)).toEqual({
    required: [],
    requiredTemplates: ["o11y.config"],
  });
  expect(METRIC_SCHEMA_VIOLATIONS).toBe("o11y.schema.violations");
});

test("RUM conventions", () => {
  expect(ATTR_RUM_VIEW_NAME).toBe("o11y.rum.view.name");
  expect(METRIC_RUM_VITAL_LCP).toBe("o11y.rum.vital.lcp");
  expect(EVENT_RUM_ERROR).toBe("o11y.rum.error");
  expect(RUM_VIEW_KIND_VALUES).toContain("screen");
  expect(RUM_SPAN_REQUIRED.get("view")).toEqual([
    "o11y.rum.platform",
    "o11y.rum.view.name",
    "o11y.rum.view.id",
    "o11y.rum.view.kind",
    "session.id",
  ]);
  expect(SENSITIVITY_OF.get("o11y.rum.element.text")).toBe("pii");
  expect(SENSITIVITY_OF.get("session.id")).toBe("internal");
  expect(SENSITIVITY_OF.get("geo.country.iso_code")).toBe("public");
  expect(RUM_CONNECTION_EFFECTIVE_VALUE_SLOW_2G).toBe("slow-2g");
  expect(RUM_CONNECTION_EFFECTIVE_VALUE_TYPE_2G).toBe("2g");
  expect(RUM_VITAL_RATING_VALUE_NEEDS_IMPROVEMENT).toBe("needs-improvement");
});
