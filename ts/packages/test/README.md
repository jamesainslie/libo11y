# @libo11y/test

The libo11y test harness for TypeScript, the counterpart of Go's
`o11ytest`. It has a hermetic recorder that captures spans, logs and
metrics in memory, assertions for the libo11y specification and for
correlation, and an in-process OTLP/HTTP sink. It runs on Bun and Node,
including Playwright's Node test runner. It does not run in browsers.

```sh
npm install --save-dev @libo11y/test
```

## Quick start

```ts
import { createRecorder } from "@libo11y/test";

const rec = await createRecorder({ serviceName: "checkout" });
const service = new CheckoutService(rec.telemetry); // inject the providers or the logger
await service.handle(order);

rec.spans(); // ended spans, in end order, already redacted
rec.logs(); // log records as the OTLP leg emitted them, already classified
await rec.exemplars("http.server.request.duration");

await rec.assertConforms(); // tier-0 identity, no secrets, event contracts
rec.assertCorrelated(); // every log emitted inside a span carries its trace ID
await rec.assertTriangle({ metric: "http.server.request.duration" });
await rec.shutdown();
```

To record HTTP telemetry, pass `{ telemetry: rec.telemetry }` to
`instrumentServe` or `instrumentFetch` from `@libo11y/server`.

## The recorder

`createRecorder(options?)` builds a telemetry with `hermetic: true`, so no
`OTEL_*` variable has any effect, and it never installs a provider
globally. It takes every `TelemetryOptions` field except the injected
pipeline (`spanExporter`, `spanProcessor`, `metricReader`, `logExporter`,
`logProcessor`, `logExport`) and `hermetic`. Caller options win over these
defaults:

| Option           | Recorder default |
| ---------------- | ---------------- |
| `serviceName`    | `"test"`         |
| `environment`    | `"test"`         |
| `logLevel`       | `"debug"`        |
| `console`        | `false`          |
| `runtimeMetrics` | `false`          |
| `startupSummary` | `false`          |
| `sampler`        | always on        |
| `exemplarFilter` | `"trace_based"`  |

| Member                       | What it does                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telemetry`                  | the hermetic telemetry. Inject its providers, propagator or logger into the code under test                                                                                                                                       |
| `spans()`                    | every span ended so far, in end order, already redacted                                                                                                                                                                           |
| `logs()`                     | every log record the OTLP leg emitted so far, already classified                                                                                                                                                                  |
| `metrics()`                  | collects every instrument through a manual reader, with exemplars attached                                                                                                                                                        |
| `metricNames()`              | the names of every instrument with recorded data                                                                                                                                                                                  |
| `exemplars(instrument)`      | the exemplars on the named instrument, across its data points                                                                                                                                                                     |
| `assertConforms()`           | throws unless the tier-0 resource keys are present, no secret-classified attribute was counted or is visible in a log or span, and every registered event carries the attributes its contract requires. Call it before `shutdown` |
| `assertCorrelated()`         | throws unless every log recorded inside a span carries that span's trace ID                                                                                                                                                       |
| `assertTriangle({ metric })` | throws unless a span, a log with its trace and span IDs, and an exemplar on `metric` with the same trace ID were all recorded                                                                                                     |
| `shutdown()`                 | shuts the telemetry down. What was recorded stays readable                                                                                                                                                                        |

The assertions throw `AssertionError` from `node:assert`.

OpenTelemetry JS keeps its context manager process-wide. When none is
registered, the recorder installs an `AsyncLocalStorageContextManager`,
and it removes that manager when the last recorder shuts down. That is the
only global it touches.

## The OTLP sink

```ts
import { startOtlpSink } from "@libo11y/test";

const sink = await startOtlpSink();
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = sink.url;
// ... run the code under test ...
await sink.waitFor("traces");
sink.traces(); // each request decoded into its OTLP/JSON shape
await sink.close();
```

The sink listens on `127.0.0.1` and accepts `POST /v1/traces`,
`/v1/metrics` and `/v1/logs` as `application/json` or
`application/x-protobuf`, plain or gzip.

| Option       | Effect                                                                           |
| ------------ | -------------------------------------------------------------------------------- |
| `status`     | the status every signal request gets. Default 200. Only a 200 stores the request |
| `retryAfter` | a `Retry-After` header on every signal response                                  |

Pass `{ status: 429, retryAfter: "1" }` to simulate a refusing collector.
`waitFor(signal, count?, timeoutMillis?)` resolves once the signal has
`count` accepted requests, 1 by default, and rejects after `timeoutMillis`,
5000 ms by default. `close()` stops the server and rejects pending
`waitFor` calls.
`requests()` lists every request with its path, media type, encoding and
size, whatever its outcome. `decodeOtlpProtobuf` and `normalizeOtlp` are
exported for tests that decode bodies themselves.

## Limits

- **JSON bodies are stored as parsed.** Protobuf bodies decode to the
  representation upstream's JSON serializers use, where 64-bit integers
  are numbers when they are safe integers. A producer that follows the
  proto3 JSON mapping and writes them as strings, such as `"count": "3"`,
  does not compare equal to the protobuf decoding under `normalizeOtlp`.
- **Bodies are capped at 32 MiB**, before and after inflating. A larger
  body gets a 413 and is not stored.
- **Protobuf messages may nest at most 100 deep.**

## Parity

[docs/PARITY.md](https://github.com/jamesainslie/libo11y/blob/main/docs/PARITY.md)
lists where the TypeScript packages match Go and where they differ, with
the reasons.
