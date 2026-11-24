# @libo11y/server

The libo11y server platform for TypeScript on Bun and Node. It binds
`@libo11y/core` to a server runtime: an `AsyncLocalStorage` context
manager, resource detection, OTLP exporters built from the `OTEL_*`
variables, a protobuf metric serializer that carries exemplars, runtime
metrics, application registry loading and signal handling.

```sh
npm install @libo11y/server
```

## Quick start

```ts
import { loadAppRegistry, setup, shutdownOnSignals } from "@libo11y/server";

const telemetry = await setup({
  serviceName: "lor-site",
  environment: "production",
  registry: await loadAppRegistry("o11y-registry.yaml"),
});
telemetry.logger.info("ready");
await shutdownOnSignals(telemetry);
```

`setup` is Go's `Setup`. It emits the `o11y.telemetry.configured` canary
and installs the context manager, providers, propagator and error handler
globally. A second call fails with `O11yError` code `ALREADY_SETUP` until
the first telemetry shuts down. `createTelemetry` is Go's `New`. It
touches no global and emits no canary. Pass its providers and propagator
to the code that needs them.

`OTEL_SDK_DISABLED=true` turns off every export. The logger still writes
to the console.

## Application registries

`loadAppRegistry(path)` reads, validates and compiles a registry file,
with the path as its source. It fails with `O11yError` code
`INVALID_APP_REGISTRY` and Go's messages:

- `o11y: reading application registry: open <path>: no such file or directory`
- `o11y: <path>: application registry is empty`
- `o11y: <path>: parsing application registry: ...`
- `o11y: invalid application registry: <path>: <violation>; <violation>`

## Signals

`shutdownOnSignals(telemetry, { signals, timeoutMillis })` waits for
`SIGINT` or `SIGTERM` by default, then resolves with the shutdown report.
Each signal gets one `process.once` listener. The first signal removes the
others, so a second signal gets the runtime's default handling and ends
the process. It never exits the process itself.

## Runtime metrics

Runtime metrics are on by default (`runtimeMetrics: false` turns them
off). They come from upstream's `RuntimeNodeInstrumentation`, on the
telemetry's meter provider, never the global one. On Bun:

- `nodejs.eventloop.utilization` is not recorded, because Bun always
  reports zero ([oven-sh/bun#34068](https://github.com/oven-sh/bun/issues/34068));
- the `v8js.*` metrics are absent: Bun 1.3.13 has no
  `v8.getHeapSpaceStatistics` and reports no GC or active-resource data
  to the instrumentation.

Shutdown stops runtime metrics before the final collection, so a process
that ends before its first periodic export sends none.

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

## Resource

The detected resource holds the upstream `telemetry.sdk.*` attributes,
`process.runtime.name` (`bun` or `nodejs`), `process.runtime.version`,
`process.runtime.description`, `host.name` and `container.id`. It never
holds the process command line, pid or `host.id`. `OTEL_RESOURCE_ATTRIBUTES`
and `OTEL_SERVICE_NAME` are read by upstream's detectors, and
`OTEL_SERVICE_NAME` wins.

On Kubernetes, pass the pod identity through the Downward API:

```yaml
env:
  - name: K8S_POD_UID
    valueFrom: { fieldRef: { fieldPath: metadata.uid } }
  - name: K8S_POD_NAME
    valueFrom: { fieldRef: { fieldPath: metadata.name } }
  - name: K8S_NAMESPACE
    valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
  - name: OTEL_RESOURCE_ATTRIBUTES
    value: k8s.pod.uid=$(K8S_POD_UID),k8s.pod.name=$(K8S_POD_NAME),k8s.namespace.name=$(K8S_NAMESPACE)
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
