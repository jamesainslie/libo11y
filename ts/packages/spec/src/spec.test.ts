import { expect, test } from "bun:test";
import {
  ATTR_OUTCOME,
  ENVIRONMENT_VALUES,
  EVENT_TELEMETRY_CONFIGURED,
  EVENTS,
  METRIC_SCHEMA_VIOLATIONS,
  OUTCOME_VALUES,
  type Outcome,
  REQUIRED_TIER0,
  RESOURCE,
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
