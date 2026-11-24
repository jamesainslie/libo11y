import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AlwaysOnSampler,
  InMemorySpanExporter,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace";
import { resolveConfig } from "./config.ts";
import { O11yError } from "./errors.ts";

function code(c: string) {
  return (err: unknown) => err instanceof O11yError && err.code === c;
}

test("defaults with an empty environment", () => {
  const c = resolveConfig({}, {});
  assert.equal(c.hermetic, false);
  assert.equal(c.sdkDisabled, false);
  assert.equal(c.traces, "otlp");
  assert.equal(c.metrics, "otlp");
  assert.equal(c.logs, "otlp");
  assert.deepEqual(c.protocol, { traces: "http/protobuf", metrics: "http/protobuf", logs: "http/protobuf" });
  assert.deepEqual(c.endpoints, {
    endpoint: undefined,
    traces_endpoint: undefined,
    metrics_endpoint: undefined,
    logs_endpoint: undefined,
  });
  assert.equal(c.sampler.name, "parentbased_always_on");
  assert.ok(c.sampler.instance instanceof ParentBasedSampler);
  assert.equal(c.exemplarFilter, "trace_based");
  assert.equal(c.logLevel, "info");
  assert.equal(c.console, "json");
  assert.deepEqual(c.batch.spans, {
    scheduledDelayMillis: 5000,
    exportTimeoutMillis: 30000,
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
  });
  assert.deepEqual(c.batch.logs, {
    scheduledDelayMillis: 1000,
    exportTimeoutMillis: 30000,
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
  });
  assert.deepEqual(c.metricExport, { intervalMillis: 60000, timeoutMillis: 30000 });
  assert.equal(c.runtimeMetrics, true);
  assert.equal(c.startupSummary, true);
});

test("exporter variables take the first value, trimmed and lowercased", () => {
  const c = resolveConfig(
    {},
    { OTEL_TRACES_EXPORTER: " Console , otlp", OTEL_METRICS_EXPORTER: "NONE", OTEL_LOGS_EXPORTER: " " },
  );
  assert.equal(c.traces, "console");
  assert.equal(c.metrics, "none");
  assert.equal(c.logs, "otlp");
});

test("an unknown exporter is an EXPORTER error with Go's wording", () => {
  const cases = [
    ["OTEL_TRACES_EXPORTER", "o11y: building span exporter: unknown exporter or metrics producer"],
    ["OTEL_METRICS_EXPORTER", "o11y: building metric reader: unknown exporter or metrics producer"],
    ["OTEL_LOGS_EXPORTER", "o11y: building log exporter: unknown exporter or metrics producer"],
  ] as const;
  for (const [name, message] of cases) {
    assert.throws(
      () => resolveConfig({}, { [name]: "zipkin" }),
      (err: unknown) => err instanceof O11yError && err.code === "EXPORTER" && err.message === message,
    );
  }
});

test("injected exporters and readers route as injected, whatever the environment says", () => {
  const c = resolveConfig(
    { spanExporter: new InMemorySpanExporter(), metricReader: {} as never, logExporter: {} as never },
    { OTEL_TRACES_EXPORTER: "none", OTEL_METRICS_EXPORTER: "bogus" },
  );
  assert.equal(c.traces, "injected");
  assert.equal(c.metrics, "injected");
  assert.equal(c.logs, "injected");
  assert.equal(resolveConfig({ spanProcessor: {} as never }, {}).traces, "injected");
});

test("logExport false turns the log route off, even with an exporter", () => {
  assert.equal(resolveConfig({ logExport: false }, {}).logs, "none");
  assert.equal(resolveConfig({ logExport: false, logExporter: {} as never }, {}).logs, "none");
});

test("hermetic mode ignores the environment and turns off signals with nothing injected", () => {
  const env = {
    OTEL_TRACES_EXPORTER: "console",
    OTEL_SDK_DISABLED: "true",
    OTEL_TRACES_SAMPLER: "always_off",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    OTEL_BLRP_SCHEDULE_DELAY: "9",
    OTEL_BSP_MAX_QUEUE_SIZE: "9",
    OTEL_METRICS_EXEMPLAR_FILTER: "always_on",
  };
  const c = resolveConfig({ hermetic: true, logExporter: {} as never }, env);
  assert.equal(c.hermetic, true);
  assert.equal(c.sdkDisabled, false);
  assert.equal(c.traces, "none");
  assert.equal(c.metrics, "none");
  assert.equal(c.logs, "injected");
  assert.equal(c.sampler.name, "parentbased_always_on");
  assert.equal(c.endpoints.endpoint, undefined);
  assert.equal(c.exemplarFilter, "trace_based");
  assert.deepEqual(c.batch.logs, {
    scheduledDelayMillis: 1000,
    exportTimeoutMillis: 30000,
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
  });
  assert.equal(c.batch.spans.maxQueueSize, 2048);
  assert.equal(resolveConfig({ hermetic: true }, {}).logs, "none");
});

test("OTEL_SDK_DISABLED turns every route and runtime metrics off", () => {
  const c = resolveConfig({ spanExporter: new InMemorySpanExporter() }, { OTEL_SDK_DISABLED: " TRUE " });
  assert.equal(c.sdkDisabled, true);
  assert.equal(c.traces, "none");
  assert.equal(c.metrics, "none");
  assert.equal(c.logs, "none");
  assert.equal(c.runtimeMetrics, false);
  assert.equal(c.console, "json");
  assert.equal(resolveConfig({}, { OTEL_SDK_DISABLED: "false" }).sdkDisabled, false);
});

test("protocols come per signal, then from the general variable", () => {
  const c = resolveConfig(
    {},
    { OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: " http/protobuf " },
  );
  assert.deepEqual(c.protocol, { traces: "http/json", metrics: "http/protobuf", logs: "http/json" });
});

test("grpc, or any other protocol, is refused for a signal routed to otlp", () => {
  assert.throws(
    () => resolveConfig({}, { OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "grpc" }),
    (err: unknown) =>
      err instanceof O11yError &&
      err.code === "UNSUPPORTED_PROTOCOL" &&
      err.message === 'o11y: unsupported OTLP protocol "grpc" for traces: use http/protobuf or http/json',
  );
  assert.throws(
    () => resolveConfig({}, { OTEL_EXPORTER_OTLP_PROTOCOL: "thrift" }),
    code("UNSUPPORTED_PROTOCOL"),
  );
  const c = resolveConfig(
    {},
    {
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      OTEL_TRACES_EXPORTER: "none",
      OTEL_METRICS_EXPORTER: "console",
      OTEL_LOGS_EXPORTER: "none",
    },
  );
  assert.equal(c.protocol.traces, "grpc");
});

test("endpoints are sanitized", () => {
  const c = resolveConfig(
    {},
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:tok3n@collector.example:4318/v1?api_key=k3y",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "://bad",
    },
  );
  assert.deepEqual(c.endpoints, {
    endpoint: "https://collector.example:4318/v1",
    traces_endpoint: undefined,
    metrics_endpoint: undefined,
    logs_endpoint: "unparseable",
  });
});

test("the sampler comes from OTEL_TRACES_SAMPLER and its argument", () => {
  const ratio = resolveConfig({}, { OTEL_TRACES_SAMPLER: " TraceIdRatio ", OTEL_TRACES_SAMPLER_ARG: "0.25" });
  assert.equal(ratio.sampler.name, "traceidratio");
  assert.ok(ratio.sampler.instance instanceof TraceIdRatioBasedSampler);
  assert.equal(ratio.sampler.instance.toString(), "TraceIdRatioBased{0.25}");
  const parent = resolveConfig(
    {},
    { OTEL_TRACES_SAMPLER: "parentbased_traceidratio", OTEL_TRACES_SAMPLER_ARG: "x" },
  );
  assert.equal(parent.sampler.name, "parentbased_traceidratio");
  assert.match(parent.sampler.instance.toString(), /TraceIdRatioBased\{1\}/);
  for (const [name, desc] of [
    ["always_on", "AlwaysOnSampler"],
    ["always_off", "AlwaysOffSampler"],
    ["parentbased_always_off", "ParentBased{root=AlwaysOffSampler"],
  ] as const) {
    const c = resolveConfig({}, { OTEL_TRACES_SAMPLER: name });
    assert.equal(c.sampler.name, name);
    assert.ok(c.sampler.instance.toString().startsWith(desc), c.sampler.instance.toString());
  }
});

test("an unknown sampler falls back to parentbased_always_on and is reported as such", () => {
  const c = resolveConfig({}, { OTEL_TRACES_SAMPLER: "jaeger_remote" });
  assert.equal(c.sampler.name, "parentbased_always_on");
  assert.ok(c.sampler.instance instanceof ParentBasedSampler);
});

test("an explicit sampler wins and is named by its description", () => {
  const sampler = new AlwaysOnSampler();
  const c = resolveConfig({ sampler }, { OTEL_TRACES_SAMPLER: "always_off" });
  assert.equal(c.sampler.instance, sampler);
  assert.equal(c.sampler.name, "AlwaysOnSampler");
});

test("the exemplar filter comes from the option, then the environment", () => {
  assert.equal(
    resolveConfig({}, { OTEL_METRICS_EXEMPLAR_FILTER: " Always_Off " }).exemplarFilter,
    "always_off",
  );
  assert.equal(resolveConfig({}, { OTEL_METRICS_EXEMPLAR_FILTER: "bogus" }).exemplarFilter, "trace_based");
  assert.equal(
    resolveConfig({ exemplarFilter: "always_on" }, { OTEL_METRICS_EXEMPLAR_FILTER: "always_off" })
      .exemplarFilter,
    "always_on",
  );
});

test("batch and metric export numbers parse as integers; invalid or negative keeps the default", () => {
  const c = resolveConfig(
    {},
    {
      OTEL_BSP_SCHEDULE_DELAY: " 100 ",
      OTEL_BSP_EXPORT_TIMEOUT: "-1",
      OTEL_BSP_MAX_QUEUE_SIZE: "abc",
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "64.9",
      OTEL_BLRP_SCHEDULE_DELAY: "0",
      OTEL_BLRP_EXPORT_TIMEOUT: "700",
      OTEL_BLRP_MAX_QUEUE_SIZE: "4096",
      OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: "",
      OTEL_METRIC_EXPORT_INTERVAL: "15000",
      OTEL_METRIC_EXPORT_TIMEOUT: "10ms",
    },
  );
  assert.deepEqual(c.batch.spans, {
    scheduledDelayMillis: 100,
    exportTimeoutMillis: 30000,
    maxQueueSize: 2048,
    maxExportBatchSize: 64,
  });
  assert.deepEqual(c.batch.logs, {
    scheduledDelayMillis: 0,
    exportTimeoutMillis: 700,
    maxQueueSize: 4096,
    maxExportBatchSize: 512,
  });
  assert.deepEqual(c.metricExport, { intervalMillis: 15000, timeoutMillis: 10 });
});

test("options set the level, console, runtime metrics and summary", () => {
  const c = resolveConfig(
    { logLevel: "debug", console: false, runtimeMetrics: false, startupSummary: false },
    {},
  );
  assert.equal(c.logLevel, "debug");
  assert.equal(c.console, "off");
  assert.equal(c.runtimeMetrics, false);
  assert.equal(c.startupSummary, false);
  assert.equal(resolveConfig({ console: "text" }, {}).console, "text");
});
