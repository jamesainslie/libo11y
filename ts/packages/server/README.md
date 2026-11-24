# @libo11y/server

The libo11y server platform for TypeScript on Bun 1.3.13 and Node 24. It
binds [`@libo11y/core`](https://github.com/jamesainslie/libo11y/tree/main/ts/packages/core) to a server runtime with an
`AsyncLocalStorage` context manager, resource detection, OTLP exporters
built from the `OTEL_*` variables, a protobuf metric serializer that
carries exemplars, runtime metrics, application registry loading and
signal handling. `instrumentServe` and `instrumentFetch` instrument HTTP
servers and clients.

```sh
npm install @libo11y/server
```

## Quick start

```ts
import { instrumentFetch, instrumentServe, loadAppRegistry, setup, shutdownOnSignals } from "@libo11y/server";

const telemetry = await setup({
  serviceName: "checkout",
  environment: "production",
  registry: await loadAppRegistry("o11y-registry.yaml"),
});

const upstream = instrumentFetch(fetch, { peerService: "inventory" });
const server = Bun.serve({
  port: 8080,
  fetch: instrumentServe(
    async (req) => {
      const stock = await upstream("http://inventory.internal/stock");
      telemetry.logger.info("stock loaded");
      return new Response(stock.ok ? "in stock" : "unknown");
    },
    { route: () => "/stock", serverTiming: true },
  ),
});
telemetry.logger.info("listening", { "server.port": server.port ?? 0 });

const report = await shutdownOnSignals(telemetry, { beforeShutdown: () => server.stop() });
if (!report.ok) process.exitCode = 1;
```

`setup` is Go's `Setup`. It emits the `o11y.telemetry.configured` canary
and installs the context manager, providers, propagator and error handler
globally. A second call fails with `O11yError` code `ALREADY_SETUP` until
the first telemetry shuts down. `createTelemetry` is Go's `New`. It
touches no global and emits no canary. Pass its `telemetry` to
`instrumentServe` and `instrumentFetch`, and its providers and propagator
to other code that needs them.

Both take the `TelemetryOptions` that the
[core README](https://github.com/jamesainslie/libo11y/tree/main/ts/packages/core#options) lists. `OTEL_SDK_DISABLED=true`
turns off every export, injected exporters included, and runtime metrics.
The logger still writes to the console.

This package re-exports the core types an application needs most:
`Telemetry`, `TelemetryOptions`, `Logger`, `SignalReport`,
`LifecycleOptions`, `O11yError` and `O11yErrorCode`.

The repository has two complete examples:
[`examples/bun-server`](https://github.com/jamesainslie/libo11y/tree/main/ts/examples/bun-server) and
[`examples/node-server`](https://github.com/jamesainslie/libo11y/tree/main/ts/examples/node-server), a `node:http` server
with a `Request` and `Response` adapter.

## HTTP servers

`instrumentServe(handler, opts?)` wraps a fetch-style handler,
`(req: Request, ...rest) => Response`, as `Bun.serve`, Hono, Elysia and
`node:http` adapters use. It is the counterpart of Go's
`o11yhttp.NewHandler`. Each request gets a SERVER span named
`<METHOD> <route>`, or by method alone without a route, the `http.server.request.duration` histogram with
exemplars, and optionally the `o11y.request.summary` canonical line. The
handler runs inside the span's context, so the spans and logs it makes are
children of it. A thrown error marks the span failed, records the
exception and a 500, and is thrown again.

| Option           | Effect                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telemetry`      | the telemetry whose providers and propagator to use. Default: the globals `setup` installs                                                                                                                                             |
| `route`          | resolves the route template of a request, such as `/projects/:id`, for the span name, `http.route` and the metric. A template that starts with a method and a space, such as `GET /x`, names the span verbatim                         |
| `publicEndpoint` | an internet-facing server. Inbound trace context starts a new root span linked to it, instead of becoming its parent. Baggage is still extracted                                                                                       |
| `ignorePaths`    | URL paths to leave uninstrumented, as Go `path.Match` patterns such as `/healthz` or `/debug/*`, matched against the decoded path as Go matches them                                                                                   |
| `serverTiming`   | adds `Server-Timing: traceparent;desc="00-<trace>-<span>-<flags>"` to `text/html` responses, so the page can join the server's trace                                                                                                   |
| `canonicalLine`  | emits one `o11y.request.summary` event per request with the request's wide record. It needs `telemetry`                                                                                                                                |
| `watchBody`      | `watchBody(res)` decides which responses end the span when the body finishes. Default: `text/html` and `text/event-stream` bodies. Other responses end the span when the handler returns, and keep their `Content-Length` and sendfile |

A framework that routes inside its own handler, such as TanStack Start,
calls `setRoute(route)` from inside the handler. It sets `http.route` and
the span name for the current request.

## HTTP clients

`instrumentFetch(fetchImpl?, opts?)` wraps a fetch function and returns a
new one. It is the counterpart of Go's `o11yhttp.NewTransport`. It never
patches `globalThis.fetch`, and it works on Bun, whose fetch publishes
none of the diagnostics channels that Node's upstream instrumentation
reads. Each request gets a CLIENT span named by method and the
`http.client.request.duration` histogram. The span ends when the response
headers arrive. A 4xx or 5xx response or a failed request marks it failed.
The trace context goes into a copy of the request headers, and the caller's
`Request` and `init` are never changed.

| Option        | Effect                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `telemetry`   | the telemetry whose providers and propagator to use. Default: the globals `setup` installs                              |
| `propagate`   | `propagate(url)` decides per destination whether the trace context and baggage are injected. Default: every destination |
| `peerService` | the `peer.service` attribute, the logical name of the service called                                                    |

## Application registries

`loadAppRegistry(path)` reads, validates and compiles a registry file,
with the path as its source. It fails with `O11yError` code
`INVALID_APP_REGISTRY` and Go's messages:

- `o11y: reading application registry: open <path>: no such file or directory`
- `o11y: <path>: application registry is empty`
- `o11y: <path>: parsing application registry: ...`
- `o11y: invalid application registry: <path>: <violation>; <violation>`

## Signals

`shutdownOnSignals(telemetry, opts?)` waits for a termination signal, runs
`beforeShutdown`, then shuts the telemetry down and resolves with the
report. Each signal gets one `process.once` listener. The first signal
removes the others, so a second signal gets the runtime's default handling
and ends the process. It never exits the process itself.

| Option           | Effect                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signals`        | the signal names to wait for. Default `["SIGINT", "SIGTERM"]`                                                                                       |
| `timeoutMillis`  | the shutdown deadline. Default 5000 ms, shutdown's own                                                                                              |
| `beforeShutdown` | runs after the signal and before telemetry shutdown. Stop the HTTP server here, so in-flight requests finish while their telemetry can still export |

## Runtime metrics

Runtime metrics are on by default, and `runtimeMetrics: false` turns them
off. They come from upstream's `RuntimeNodeInstrumentation`, on the
telemetry's meter provider, never the global one. On Bun:

- `nodejs.eventloop.utilization` is not recorded, because Bun always
  reports zero ([oven-sh/bun#34068](https://github.com/oven-sh/bun/issues/34068)).
- The `v8js.*` metrics are absent, because Bun 1.3.13 has no
  `v8.getHeapSpaceStatistics` and reports no GC or active-resource data
  to the instrumentation.

Shutdown stops runtime metrics after the meter provider's final
collection, so a process that ends before its first periodic export still
reports them.

## Exporters

`serverPlatform()` builds the exporters core asks for from the `OTEL_*`
variables. `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` and
`OTEL_LOGS_EXPORTER` take `otlp` (the default), `console` or `none`. The
protocol is `http/protobuf` by default, or `http/json`, from
`OTEL_EXPORTER_OTLP_PROTOCOL` and its per-signal forms. `grpc` fails with
`UNSUPPORTED_PROTOCOL`.

Traces and logs use the upstream OTLP exporters. Metrics use upstream's
OTLP transport with libo11y's serializers, which write exemplars:
`OtlpProtobufMetricsSerializer` from this package, and core's
`OtlpJsonMetricsSerializer`. Upstream reads every other
`OTEL_EXPORTER_OTLP_*` variable, such as the endpoints, headers,
certificates, compression and
`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`. An
`OTEL_METRIC_EXPORT_TIMEOUT` above `OTEL_METRIC_EXPORT_INTERVAL` is
clamped to the interval, as sdk-node does.

The export timeout defaults to 5000 ms for spans, logs and metrics, where
sdk-node uses 30000 ms. Upstream's batch processors and periodic reader
arm an export timer that does not let the process exit, so a hung exporter
keeps an exiting process alive until the timer fires, even after shutdown
has resolved. The 5000 ms default matches the shutdown deadline. An
explicit `OTEL_BSP_EXPORT_TIMEOUT`, `OTEL_BLRP_EXPORT_TIMEOUT` or
`OTEL_METRIC_EXPORT_TIMEOUT` still wins.

## Resource

The detected resource holds the upstream `telemetry.sdk.*` attributes,
`process.runtime.name` (`bun` or `nodejs`), `process.runtime.version`,
`process.runtime.description`, `host.name` and `container.id`. It never
holds the process command line, the pid or `host.id`. Upstream's detectors
read `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SERVICE_NAME`, and
`OTEL_SERVICE_NAME` wins.

There is no Kubernetes detector, as in Go. Pass the pod identity through
the Downward API and `OTEL_RESOURCE_ATTRIBUTES`. Kubernetes expands
`$(NAME)` from variables defined earlier in the list:

```yaml
env:
  - name: POD_UID
    valueFrom: { fieldRef: { fieldPath: metadata.uid } }
  - name: POD_NAME
    valueFrom: { fieldRef: { fieldPath: metadata.name } }
  - name: POD_NAMESPACE
    valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
  - name: OTEL_RESOURCE_ATTRIBUTES
    value: k8s.pod.uid=$(POD_UID),k8s.pod.name=$(POD_NAME),k8s.namespace.name=$(POD_NAMESPACE),deployment.environment.name=production
```

`service.instance.id` is then the UUIDv5 of the pod UID, the same ID every
libo11y implementation derives.

## Context

`createContextManager()` returns OpenTelemetry's `AsyncLocalStorage`
context manager, which `setup` installs. On Bun 1.3.13 it loses the active
context in three places:

- An async generator used as a `Bun.serve` response body
  ([oven-sh/bun#24199](https://github.com/oven-sh/bun/issues/24199)).
  Use a `ReadableStream` body instead. `instrumentServe` still ends its
  span correctly.
- A thenable returned from an async function after an `await`
  ([oven-sh/bun#34266](https://github.com/oven-sh/bun/issues/34266)).
- `unhandledRejection` listeners
  ([oven-sh/bun#40223](https://github.com/oven-sh/bun/issues/40223)).

Node 24 keeps the context in both of the last two cases.

## Known limitations

- Upstream's `RuntimeNodeInstrumentation` installs a require-in-the-middle
  hook on `Module.prototype.require`. The hook stays for the life of the
  process, even after `shutdown()`. Pass `runtimeMetrics: false` to avoid
  it.
- OTLP over gRPC is not supported.

## Parity

[docs/PARITY.md](https://github.com/jamesainslie/libo11y/blob/main/docs/PARITY.md)
lists where the TypeScript packages match Go and where they differ, with
the reasons.
