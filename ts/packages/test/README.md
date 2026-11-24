# @libo11y/test

The libo11y test harness for TypeScript. It has a hermetic recorder that
captures spans, logs and metrics in memory, assertions for the libo11y
specification and for correlation, and an in-process OTLP/HTTP sink. It
runs on Bun and Node, including Playwright's Node test runner. It does not
run in browsers.

```sh
npm install --save-dev @libo11y/test
```

## The recorder

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

The recorder ignores every `OTEL_*` variable and never installs a provider
globally. OpenTelemetry JS keeps its context manager process-wide, so when
none is registered the recorder installs an `AsyncLocalStorageContextManager`.
That is the only global it touches. The assertions throw `AssertionError`
from `node:assert`.

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

The sink accepts `POST /v1/traces`, `/v1/metrics` and `/v1/logs` as
`application/json` or `application/x-protobuf`, plain or gzip. Pass
`{ status: 429, retryAfter: "1" }` to simulate a refusing collector.

## Limits

- **JSON bodies are stored as parsed.** Protobuf bodies decode to the
  representation upstream's JSON serializers use: 64-bit integers are
  numbers when they are safe integers. A producer that follows the proto3
  JSON mapping and writes them as strings, such as `"count": "3"`, does not
  compare equal to the protobuf decoding under `normalizeOtlp`.
- **Bodies are capped at 32 MiB**, before and after inflating. A larger
  body is answered with 413 and not stored.
- **Protobuf messages may nest at most 100 deep.**
