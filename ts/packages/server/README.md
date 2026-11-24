# @libo11y/server

The libo11y server platform for TypeScript on Bun and Node. It supplies
what `@libo11y/core` needs from a server runtime: an `AsyncLocalStorage`
context manager, resource detection, OTLP exporters built from the
`OTEL_*` variables, and the protobuf metric serializer that carries
exemplars.

```sh
npm install @libo11y/server
```

## Context

`createContextManager()` returns OpenTelemetry's `AsyncLocalStorage`
context manager. On Bun 1.3.x it loses the active context in three places:

- an async generator used as a `Bun.serve` response body
  ([oven-sh/bun#24199](https://github.com/oven-sh/bun/issues/24199));
  use a `ReadableStream` body instead;
- a thenable returned from an async function after an `await`
  ([oven-sh/bun#34266](https://github.com/oven-sh/bun/issues/34266));
- `unhandledRejection` listeners
  ([oven-sh/bun#40223](https://github.com/oven-sh/bun/issues/40223)).

## Exporters

`serverPlatform()` builds the exporters core asks for from the `OTEL_*`
variables. `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` and
`OTEL_LOGS_EXPORTER` take `otlp` (the default), `console` or `none`. The
protocol is `http/protobuf` by default, or `http/json`, from
`OTEL_EXPORTER_OTLP_PROTOCOL` and its per-signal forms. `grpc` is refused
with `UNSUPPORTED_PROTOCOL`.

Traces and logs use the upstream OTLP exporters. Metrics use upstream's
OTLP transport with libo11y's serializers, which write exemplars:
`OtlpProtobufMetricsSerializer` from this package, and core's
`OtlpJsonMetricsSerializer`. Every other `OTEL_EXPORTER_OTLP_*` variable,
such as the endpoints, headers, compression and
`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`, is read by upstream.
An `OTEL_METRIC_EXPORT_TIMEOUT` above `OTEL_METRIC_EXPORT_INTERVAL` is
clamped to the interval, as sdk-node does.
