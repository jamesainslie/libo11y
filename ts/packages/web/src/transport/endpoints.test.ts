/** The OTLP URL of each signal: precedence, joining, relative URLs and hermetic. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEndpoints } from "./endpoints.ts";

const BASE = "https://app.example.com/shop/page.html";

test("nothing configured gives no endpoints", () => {
  assert.deepEqual(resolveEndpoints({}, false, BASE), {
    traces: undefined,
    metrics: undefined,
    logs: undefined,
  });
});

test("endpoint is joined with v1/<signal>, adding a slash when the base lacks one", () => {
  assert.deepEqual(resolveEndpoints({ endpoint: "https://otel.example.com/otlp" }, false, BASE), {
    traces: "https://otel.example.com/otlp/v1/traces",
    metrics: "https://otel.example.com/otlp/v1/metrics",
    logs: "https://otel.example.com/otlp/v1/logs",
  });
  assert.equal(
    resolveEndpoints({ endpoint: "https://otel.example.com/otlp/" }, false, BASE).traces,
    "https://otel.example.com/otlp/v1/traces",
  );
  assert.equal(
    resolveEndpoints({ endpoint: "https://otel.example.com" }, false, BASE).logs,
    "https://otel.example.com/v1/logs",
  );
});

test("a per-signal option is used as is and beats everything", () => {
  const got = resolveEndpoints(
    {
      endpoint: "https://otel.example.com",
      tracesEndpoint: "https://traces.example.com/custom",
      env: {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://env-traces.example.com/x",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://env.example.com",
      },
    },
    false,
    BASE,
  );
  assert.equal(got.traces, "https://traces.example.com/custom");
  assert.equal(got.metrics, "https://otel.example.com/v1/metrics");
});

test("the endpoint option beats env per-signal, which beats env OTEL_EXPORTER_OTLP_ENDPOINT", () => {
  // DESIGN.md "Configuration": an explicit code option, then the standard OTEL_* variable.
  const got = resolveEndpoints(
    {
      endpoint: "https://opt.example.com",
      env: {
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://env-metrics.example.com/m",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://env.example.com",
      },
    },
    false,
    BASE,
  );
  assert.equal(got.metrics, "https://opt.example.com/v1/metrics");
  assert.equal(got.traces, "https://opt.example.com/v1/traces");
  const envSignal = resolveEndpoints(
    {
      env: {
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://env-metrics.example.com/m",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://env.example.com",
      },
    },
    false,
    BASE,
  );
  assert.equal(envSignal.metrics, "https://env-metrics.example.com/m");
  assert.equal(envSignal.traces, "https://env.example.com/v1/traces");
  const envOnly = resolveEndpoints(
    { env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://env.example.com/" } },
    false,
    BASE,
  );
  assert.equal(envOnly.logs, "https://env.example.com/v1/logs");
});

test("relative URLs resolve against base", () => {
  const got = resolveEndpoints({ endpoint: "/otlp", logsEndpoint: "collect/logs" }, false, BASE);
  assert.equal(got.traces, "https://app.example.com/otlp/v1/traces");
  assert.equal(got.logs, "https://app.example.com/shop/collect/logs");
});

test("hermetic ignores env", () => {
  const got = resolveEndpoints(
    {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://env.example.com",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://env.example.com/t",
      },
      metricsEndpoint: "https://m.example.com/m",
    },
    true,
    BASE,
  );
  assert.deepEqual(got, { traces: undefined, metrics: "https://m.example.com/m", logs: undefined });
});

test("an unparseable URL leaves that signal undefined", () => {
  const got = resolveEndpoints(
    { endpoint: "https://otel.example.com", tracesEndpoint: "http://[bad" },
    false,
    BASE,
  );
  assert.equal(got.traces, undefined);
  assert.equal(got.metrics, "https://otel.example.com/v1/metrics");
  assert.equal(resolveEndpoints({ endpoint: "relative/only" }, false, undefined).traces, undefined);
});

test("empty strings count as unset", () => {
  const got = resolveEndpoints(
    { tracesEndpoint: "", env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://env.example.com" } },
    false,
    BASE,
  );
  assert.equal(got.traces, "https://env.example.com/v1/traces");
});
