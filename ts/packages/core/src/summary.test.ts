import assert from "node:assert/strict";
import { test } from "node:test";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AlwaysOnSampler } from "@opentelemetry/sdk-trace";
import { resolveConfig } from "./config.ts";
import { buildSummary } from "./summary.ts";

const FIELDS = ["traceparent", "tracestate", "baggage"];

test("attributes follow Go's order and every value is a string", () => {
  const config = resolveConfig(
    { logLevel: "debug", console: "text" },
    {
      OTEL_TRACES_EXPORTER: "console",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_TRACES_SAMPLER: "always_off",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:tok3n@collector.example:4318/v1?api_key=k3y#frag",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "user:pw@collector.example:4317",
    },
  );
  const resource = resourceFromAttributes({ "service.name": "svc", "service.version": "0.0.0-unknown" });
  const { attributes, effectiveConfig } = buildSummary(config, resource, {
    versionFallback: true,
    propagatorFields: FIELDS,
    runtimeMetrics: false,
  });
  assert.deepEqual(Object.entries(attributes), [
    ["service.name", "svc"],
    ["service.version", "0.0.0-unknown"],
    ["o11y.config.traces", "console"],
    ["o11y.config.metrics", "none"],
    ["o11y.config.logs", "otlp"],
    ["o11y.config.console", "text"],
    ["o11y.config.level", "DEBUG"],
    ["o11y.config.sampler", "always_off"],
    ["o11y.config.propagators", "traceparent,tracestate,baggage"],
    ["o11y.config.runtime_metrics", "false"],
    ["o11y.config.service_version_fallback", "true"],
    ["o11y.config.endpoint", "https://collector.example:4318/v1"],
    ["o11y.config.logs_endpoint", "collector.example:4317"],
  ]);
  assert.equal(
    effectiveConfig,
    "service.name=svc service.version=0.0.0-unknown o11y.config.traces=console o11y.config.metrics=none " +
      "o11y.config.logs=otlp o11y.config.console=text o11y.config.level=DEBUG o11y.config.sampler=always_off " +
      "o11y.config.propagators=traceparent,tracestate,baggage o11y.config.runtime_metrics=false " +
      "o11y.config.service_version_fallback=true o11y.config.endpoint=https://collector.example:4318/v1 " +
      "o11y.config.logs_endpoint=collector.example:4317",
  );
});

test("hermetic injected signals, an explicit sampler, console off and no version", () => {
  const sampler = new AlwaysOnSampler();
  const config = resolveConfig(
    { hermetic: true, console: false, sampler, spanExporter: {} as never, logExport: false },
    { OTEL_EXPORTER_OTLP_ENDPOINT: "http://ignored" },
  );
  const { attributes } = buildSummary(config, resourceFromAttributes({ "service.name": "svc" }), {
    versionFallback: false,
    propagatorFields: FIELDS,
    runtimeMetrics: true,
  });
  assert.deepEqual(Object.entries(attributes), [
    ["service.name", "svc"],
    ["o11y.config.traces", "injected"],
    ["o11y.config.metrics", "none"],
    ["o11y.config.logs", "none"],
    ["o11y.config.console", "off"],
    ["o11y.config.level", "INFO"],
    ["o11y.config.sampler", sampler.toString()],
    ["o11y.config.propagators", "traceparent,tracestate,baggage"],
    ["o11y.config.runtime_metrics", "true"],
  ]);
});
