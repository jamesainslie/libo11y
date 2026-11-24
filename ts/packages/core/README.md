# @libo11y/core

The platform-neutral libo11y core for TypeScript. It resolves the
configuration, enforces the identity contract and the sensitivity policy,
and builds the trace, metric and log pipelines over the OpenTelemetry JS
SDK 3.x. It has no runtime dependencies beyond OpenTelemetry and
`@libo11y/spec`.

Core does not detect resources, build exporters or carry async context by
itself. A runtime package supplies those as a `Platform`. On Bun and Node
that package is [`@libo11y/server`](https://github.com/jamesainslie/libo11y/tree/main/ts/packages/server), which exports `setup` and
`createTelemetry` with its platform already bound. A browser platform is
planned for `ts/v0.2.0`.

```sh
npm install @libo11y/server @libo11y/core @opentelemetry/api
```

An application calls `setup` from `@libo11y/server`, which also re-exports
the `Telemetry`, `TelemetryOptions`, `Logger`, `SignalReport` and
`LifecycleOptions` types and `O11yError`. It imports from core directly
only for `forceEmit`, `startRecord` and `currentRecord`, and for the other
types, such as `LogAttributes` and `WideRecord`.

## Quick start

```ts
import { currentRecord, forceEmit } from "@libo11y/core";
import { instrumentServe, setup } from "@libo11y/server";
import { context } from "@opentelemetry/api";

const telemetry = await setup({ serviceName: "checkout", environment: "production" });

telemetry.logger.info("ready", { "server.port": 8080 });
telemetry.event("checkout.completed", { "checkout.order.items": 3 });

// An audit record that the level gate never drops.
context.with(forceEmit(), () => telemetry.logger.debug("refund approved"));

// With canonicalLine, each request emits one o11y.request.summary event, and
// currentRecord() inside the handler adds to it.
const handler = instrumentServe(
  async () => {
    currentRecord().set({ "checkout.cart.size": 3 });
    return new Response("ok");
  },
  { telemetry, canonicalLine: true },
);
Bun.serve({ port: 8080, fetch: handler });
```

`setupWith(options, platform)` and `createTelemetryWith(options, platform)`
are the entry points that `@libo11y/server` binds. `setupWith` is Go's
`Setup`. It emits the `o11y.telemetry.configured` canary, then installs the
context manager, the tracer, meter and logger providers, the propagator and
a rate-limited error handler globally. `createTelemetryWith` is Go's `New`.
It touches no global and emits no canary.

## Options

Each option beats its `OTEL_*` variable, which beats the default.

| Option                                              | Effect                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `serviceName`, `serviceVersion`, `serviceNamespace` | `service.name`, `service.version` and `service.namespace`                                                                        |
| `environment`, `environmentValues`                  | `deployment.environment.name`, and values accepted beyond production, staging, development and test                              |
| `strictIdentity`                                    | default `true`. With `false`, a missing or invalid identity is counted as a violation instead of thrown                          |
| `resourceAttributes`                                | extra resource attributes. They beat every other layer and are still classified                                                  |
| `registry`                                          | one or more application registries, raw or compiled. A raw registry is validated first                                           |
| `piiMode`, `piiHashKey`                             | `"drop"` (default), `"hash"` or `"allow"`. Hash mode needs a key of at least 32 bytes                                            |
| `logLevel`                                          | the lowest level logged. Default `"info"`                                                                                        |
| `console`                                           | `"json"` (default), `"text"`, or `false` for no console sink                                                                     |
| `captureConsole`                                    | route `console.log`, `info`, `warn`, `error`, `debug` and `trace` into the logger. Default `false`                               |
| `attrReplacer`                                      | renames or drops log attributes before classification, on the console and OTLP legs                                              |
| `logExport`                                         | export logs over OTLP. Default `true`                                                                                            |
| `sampler`                                           | default `OTEL_TRACES_SAMPLER`, else `parentbased_always_on`                                                                      |
| `propagators`                                       | replaces the default W3C trace context and baggage. The baggage egress filter still wraps it                                     |
| `views`, `histogramBuckets`                         | metric views, and explicit histogram boundaries by instrument name                                                               |
| `exemplarFilter`                                    | default `OTEL_METRICS_EXEMPLAR_FILTER`, else `"trace_based"`                                                                     |
| `runtimeMetrics`                                    | runtime metrics where the platform has them. Default `true`                                                                      |
| `startupSummary`                                    | emit the startup canary in `setupWith`. Default `true`                                                                           |
| `hermetic`                                          | ignore every `OTEL_*` variable (Go `WithoutOTELEnv`). A signal with nothing injected is off                                      |
| `spanExporter`, `spanProcessor`                     | inject the trace pipeline. Exported spans are batched and redacted, and an injected processor's `onEnd` sees the redacted span   |
| `metricReader`                                      | inject a metric reader instead of the platform's                                                                                 |
| `logExporter`                                       | inject a log exporter. Records are batched and classified                                                                        |
| `logProcessor`                                      | a log record processor after the redacting processor, which sees each classified record synchronously (Go `WithExtraLogHandler`) |

## Identity

| Attribute                     | Set with                                                                            | Error when missing or invalid                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `service.name`                | `serviceName`, `OTEL_SERVICE_NAME`, or `service.name` in `OTEL_RESOURCE_ATTRIBUTES` | `NO_SERVICE_NAME`                                                              |
| `deployment.environment.name` | `environment`, or `deployment.environment.name` in `OTEL_RESOURCE_ATTRIBUTES`       | `NO_ENVIRONMENT`, or `INVALID_ENVIRONMENT` for a value outside the allowed set |
| `service.version`             | `serviceVersion`, or the environment                                                | none. It falls back to `0.0.0-unknown`, and the canary reports the fallback    |

`service.instance.id` is a UUIDv5 of the Kubernetes pod UID, else of
`<namespace>/<pod name>`, else a random UUIDv4. Every libo11y
implementation derives the same ID from the same pod identity. The resource
carries one schema URL, `SCHEMA_URL` from `@libo11y/spec`.

## The telemetry handle

| Member                                              | What it is                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `logger`                                            | the libo11y logger                                                                          |
| `tracerProvider`, `meterProvider`, `loggerProvider` | the providers. The meter provider classifies every measurement and samples it for exemplars |
| `propagator`                                        | the configured propagator, wrapped by the baggage egress filter                             |
| `resource`                                          | the composed, classified resource                                                           |
| `effectiveConfig()`                                 | the resolved configuration on one line, as the canary reports it                            |
| `event(name, attrs?, ctx?)`                         | emits a named event at info under a forced context                                          |
| `forceFlush(opts?)`                                 | exports everything buffered, signal by signal                                               |
| `shutdown(opts?)`                                   | stops every signal. Every call returns the first call's promise                             |

`shutdown` stops logs, metrics and traces concurrently under one deadline,
5000 ms unless `timeoutMillis` says otherwise. Both `shutdown` and
`forceFlush` resolve with a `SignalReport` that holds one error per failed
signal, and they never reject.

## The logger

The logger has six levels, `trace` to `fatal`, and `child(attrs)` for
bound attributes. `error` and `fatal` take an `Error` in place of the
attributes and expand it to `exception.type`, `exception.message` and
`exception.stacktrace`. `fatal` logs and returns. It never exits.

Each record goes to the console sink and to the OTLP leg, classified per
sink. Inside a valid span context, the console line carries `trace_id` and
`span_id`, and the OTLP record carries the span context.

## Sensitivity

The policy classifies by key, from the spec tables first and then from the
application registries.

| Surface                                           | Secret  | PII under `"drop"` | PII under `"hash"` | PII under `"allow"` |
| ------------------------------------------------- | ------- | ------------------ | ------------------ | ------------------- |
| logger console and OTLP legs                      | dropped | dropped            | HMAC token         | kept                |
| records from other bridges on the logger provider | dropped | dropped            | HMAC token         | kept                |
| span, span event and span link attributes         | dropped | dropped            | HMAC token         | kept                |
| resource                                          | dropped | dropped            | HMAC token         | kept                |
| metric attributes                                 | dropped | dropped            | dropped            | kept                |

Metric attributes are never tokenized, because a token per value would
multiply the series. Violations on logs, spans and the resource are counted
on `o11y.schema.violations`. The policy does not classify log record bodies,
span names, values under unclassified keys, or baggage.

## Errors

Setup and configuration failures throw `O11yError`, whose `code` is one of
the following. The messages match Go's.

| Code                                                       | Cause                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ALREADY_SETUP`                                            | `setupWith` ran again before the first telemetry shut down                    |
| `NO_SERVICE_NAME`, `NO_ENVIRONMENT`, `INVALID_ENVIRONMENT` | the identity contract failed under `strictIdentity`                           |
| `PII_HASH_KEY`                                             | `piiMode: "hash"` without a key of at least 32 bytes                          |
| `INVALID_APP_REGISTRY`                                     | an application registry broke a rule, or two registries declare one namespace |
| `CANARY_REJECTED`                                          | a sink rejected the startup canary synchronously                              |
| `UNSUPPORTED_PROTOCOL`                                     | an OTLP protocol other than `http/protobuf` or `http/json`                    |
| `EXPORTER`                                                 | an unknown `OTEL_*_EXPORTER` value, or an exporter that could not be built    |

## Exemplars

Upstream sdk-metrics 3.1.1 records no exemplars, so the core samples them
itself. The meter provider offers each synchronous measurement to an
`ExemplarStore`, and `exemplarMetricExporter` attaches the samples to the
data points of each collection. `OtlpJsonMetricsSerializer` here and
`OtlpProtobufMetricsSerializer` in `@libo11y/server` write them to OTLP.
With several metric readers, the first reader to collect gets each sample.

## Writing a platform

A `Platform` supplies the environment, resource detection, a context
manager, exporters, console and diagnostic output, hashing and UUIDs, and
optionally runtime metrics. `@libo11y/core/testing` exports
`createTestPlatform`, which takes a context manager factory and any members
a test overrides. It fills in the rest hermetically and records the console
and diagnostic lines in arrays. `exemplarStoreOf(telemetry)` returns a
telemetry's exemplar store, for a platform's own metric exporter tests.

## Parity

[docs/PARITY.md](https://github.com/jamesainslie/libo11y/blob/main/docs/PARITY.md)
lists where the TypeScript packages match Go and where they differ, with
the reasons.
