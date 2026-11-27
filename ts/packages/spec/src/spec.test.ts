import assert from "node:assert/strict";
import { test } from "node:test";
import * as spec from "./index.ts";
import {
  APP_REGISTRY_SCHEMA,
  APP_RESERVED_NAMESPACES,
  ATTR_LOG_SOURCE,
  ATTR_OUTCOME,
  ATTR_RUM_APP_UPDATE_ID,
  ATTR_RUM_SUMMARY_ERRORS_UNHANDLED_REJECTION,
  ATTR_RUM_SUMMARY_LCP_VALUE,
  ATTR_RUM_SUMMARY_SEQ,
  ATTR_RUM_VIEW_NAME,
  ENVIRONMENT_VALUES,
  EVENT_RUM_ERROR,
  EVENT_RUM_VIEW_SUMMARY,
  EVENT_TELEMETRY_CONFIGURED,
  EVENTS,
  LOG_SOURCE_VALUES,
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
} from "./index.ts";

test("the schema URL names the spec version", () => {
  assert.equal(SCHEMA_URL.endsWith(`/${SPEC_VERSION}`), true);
});

test("minted keys and closed enums", () => {
  assert.equal(ATTR_OUTCOME, "o11y.outcome");
  const success: Outcome = "success";
  assert.ok(OUTCOME_VALUES.includes(success));
  // @ts-expect-error "nope" is not an Outcome, so the union stays closed.
  const notAnOutcome: Outcome = "nope";
  void notAnOutcome;
});

test("tier 0 requires the service identity", () => {
  assert.ok(REQUIRED_TIER0.includes("service.name"));
  assert.deepEqual(RESOURCE.get("o11y.tenant.id"), {
    tier: "tier3",
    requirement: "opt_in",
    source: "option",
    role: "descriptive",
  });
});

test("the environment set", () => {
  assert.deepEqual([...ENVIRONMENT_VALUES], ["production", "staging", "development", "test"]);
});

test("sensitivity lookups never reach the prototype", () => {
  assert.equal(SENSITIVITY_OF.get("o11y.tenant.id"), "internal");
  assert.equal(SENSITIVITY_OF.get("http.request.header.authorization"), "secret");
  assert.equal(SENSITIVITY_OF.get("constructor"), undefined);
  assert.equal(SENSITIVITY_OF.get("__proto__"), undefined);
});

test("event contracts and metric names", () => {
  assert.deepEqual(EVENTS.get(EVENT_TELEMETRY_CONFIGURED), {
    required: [],
    requiredTemplates: ["o11y.config"],
  });
  assert.equal(METRIC_SCHEMA_VIOLATIONS, "o11y.schema.violations");
});

test("RUM conventions", () => {
  assert.equal(ATTR_RUM_VIEW_NAME, "o11y.rum.view.name");
  assert.equal(METRIC_RUM_VITAL_LCP, "o11y.rum.vital.lcp");
  assert.equal(EVENT_RUM_ERROR, "o11y.rum.error");
  assert.ok(RUM_VIEW_KIND_VALUES.includes("screen"));
  assert.deepEqual(RUM_SPAN_REQUIRED.get("view"), [
    "o11y.rum.span.shape",
    "o11y.rum.platform",
    "o11y.rum.view.name",
    "o11y.rum.view.id",
    "o11y.rum.view.kind",
    "session.id",
  ]);
  assert.equal(SENSITIVITY_OF.get("o11y.rum.element.text"), "pii");
  assert.equal(SENSITIVITY_OF.get("session.id"), "internal");
  assert.equal(SENSITIVITY_OF.get("geo.country.iso_code"), "public");
  assert.equal(RUM_CONNECTION_EFFECTIVE_VALUE_SLOW_2G, "slow-2g");
  assert.equal(RUM_CONNECTION_EFFECTIVE_VALUE_TYPE_2G, "2g");
  assert.equal(RUM_VITAL_RATING_VALUE_NEEDS_IMPROVEMENT, "needs-improvement");
});

test("captured console records (spec 1.2.0)", () => {
  assert.equal(SPEC_VERSION, "1.3.0");
  assert.equal(ATTR_LOG_SOURCE, "o11y.log.source");
  assert.deepEqual([...LOG_SOURCE_VALUES], ["logger", "console"]);
  assert.equal(SENSITIVITY_OF.get("o11y.log.source"), "public");
});

test("the application registry reserved namespaces", () => {
  assert.equal(APP_REGISTRY_SCHEMA, "libo11y.app-registry/v1");
  for (const ns of ["o11y", "otel", "http", "session"]) {
    assert.equal(APP_RESERVED_NAMESPACES.has(ns), true);
  }
  assert.equal(APP_RESERVED_NAMESPACES.has("lor"), false);
});

test("the view summary event (spec 1.3.0)", () => {
  assert.equal(EVENT_RUM_VIEW_SUMMARY, "o11y.rum.view.summary");
  assert.equal(ATTR_RUM_SUMMARY_SEQ, "o11y.rum.summary.seq");
  assert.equal(ATTR_RUM_SUMMARY_LCP_VALUE, "o11y.rum.summary.lcp.value");
  assert.equal(ATTR_RUM_SUMMARY_ERRORS_UNHANDLED_REJECTION, "o11y.rum.summary.errors.unhandled_rejection");
  const required = EVENTS.get(EVENT_RUM_VIEW_SUMMARY)?.required ?? [];
  for (const key of ["o11y.rum.summary.seq", "o11y.rum.summary.time_on_view", "o11y.rum.view.id"]) {
    assert.ok(required.includes(key), `missing ${key}`);
  }
});

test("the over-the-air update ID (spec 1.3.0)", () => {
  assert.equal(ATTR_RUM_APP_UPDATE_ID, "o11y.rum.app.update_id");
  assert.equal(SENSITIVITY_OF.get(ATTR_RUM_APP_UPDATE_ID), "public");
});

test("spec 1.3.0 mints the RUM detail attributes and the span shape marker", () => {
  assert.equal(spec.ATTR_RUM_ERROR_BREADCRUMBS, "o11y.rum.error.breadcrumbs");
  assert.equal(spec.ATTR_RUM_VITAL_ATTRIBUTION_INPUT_DELAY, "o11y.rum.vital.attribution.input_delay");
  assert.equal(spec.ATTR_RUM_RESOURCE_TYPE, "o11y.rum.resource.type");
  assert.equal(spec.ATTR_RUM_SERVER_TIMING_NAME, "o11y.rum.server_timing.name");
  assert.equal(spec.ATTR_RUM_SPAN_SHAPE, "o11y.rum.span.shape");
  assert.deepEqual(spec.RUM_RESOURCE_TYPE_VALUES, [
    "script",
    "stylesheet",
    "image",
    "font",
    "media",
    "document",
    "other",
  ]);
  assert.equal(SENSITIVITY_OF.get("o11y.rum.error.breadcrumbs"), "internal");
});
