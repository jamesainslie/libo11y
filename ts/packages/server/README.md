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
installs nothing in the OpenTelemetry globals and emits no canary. Pass
its `telemetry` to `instrumentServe` and `instrumentFetch`, and its
providers and propagator to other code that needs them.

Two options still reach outside a `createTelemetry` handle:

- `runtimeMetrics`, on by default, installs upstream's
  require-in-the-middle hook on `Module.prototype.require`, and the hook
  stays for the life of the process, after `shutdown` too. Pass
  `runtimeMetrics: false` to avoid it.
- `captureConsole: true` patches `globalThis.console` until `shutdown`.
  It is off by default. Leave it off to avoid it.

An option outside the closed set of values it takes, such as
`logLevel: "verbose"` or `console: "pretty"`, rejects `setup` and
`createTelemetry` with `O11yError` code `INVALID_OPTION`.

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

The telemetry never fails the request. The handler runs exactly once, and
only its own error reaches the caller:

- A propagator that throws on extract leaves the request without the
  inbound context.
- A span that cannot start leaves the request uninstrumented. So does a
  request the instrumentation cannot read, such as a value that is not a
  `Request`: the handler is called with it as if it were not wrapped.
- A span that cannot end changes nothing the caller sees.
- A handler that resolves with something that is not a `Response` gets
  that value returned unchanged.

Each of these is reported as one `o11y: telemetry error` line on stderr.
With the `telemetry` option the line goes through that telemetry's own
rate-limited handler, so it is written for a `createTelemetry` handle too.
Without it the report goes to the OpenTelemetry global error handler,
which `setup` makes libo11y's. A report names the step that failed and
the class of the error, and never the error's message, because a
propagator is handed the request's headers and its error can quote them.

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

The telemetry never fails the request here either. A propagator that
throws on inject is reported and the request is sent with its own headers.
A span that cannot start leaves the request uninstrumented. A span that
cannot end replaces neither the response nor fetch's own error. A
`fetchImpl` that resolves with something that is not a `Response` gets
that value returned unchanged. The reports are written as
`instrumentServe`'s are.

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

`beforeShutdown` and the telemetry shutdown share one deadline, and
together they never take longer than `timeoutMillis`. `beforeShutdown` may
use nine tenths of it. The shutdown gets what is left of the whole, which
is then never less than a tenth, so buffered telemetry has a chance to
leave even when `beforeShutdown` used all it was allowed. A
`beforeShutdown` still running after nine tenths of the deadline is
reported as a `lifecycle` error, and the shutdown starts without it.

| Option           | Effect                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signals`        | the signal names to wait for. Default `["SIGINT", "SIGTERM"]`                                                                                       |
| `timeoutMillis`  | the one deadline for `beforeShutdown` and the telemetry shutdown together. Default 5000 ms. Read as `shutdown` reads its own: see the core README   |
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

Each OTLP exporter is upstream's exporter base, export delegate and
configuration over libo11y's own HTTP transport. Traces and logs use
upstream's serializers. Metrics use libo11y's, which write exemplars:
`OtlpProtobufMetricsSerializer` from this package, and core's
`OtlpJsonMetricsSerializer`. Upstream reads every other
`OTEL_EXPORTER_OTLP_*` variable, shared and per signal: the endpoints,
headers, certificates, client key and certificate, compression, timeout
and `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`. An
`OTEL_METRIC_EXPORT_TIMEOUT` above `OTEL_METRIC_EXPORT_INTERVAL` is
clamped to the interval, as sdk-node does.

### The transport

Upstream does not export its HTTP transport or its retrying transport, and
neither can be stopped, so libo11y has its own. It follows upstream's in
everything a collector or a diag logger sees, apart from the six
differences below: the request and its framing, gzip, the `User-Agent`,
the statuses (429, 502, 503, 504) and network
errors that are retried, at most five retries, the backoff from one second
by half each time to five seconds with a fifth of jitter, `Retry-After` in
seconds or as an HTTP date, the time a retry is given, the 4 MiB cap on a
response body, and the diag messages about retries. The tests pin each of
these, and fail when the upstream files the transport follows change.

It differs from upstream's transport in six ways, and in no other:

1. **The timeout covers the whole attempt.** `OTEL_EXPORTER_OTLP_TIMEOUT`
   bounds connecting, sending and reading the response together. Upstream's
   timeout is an idle timeout that starts only once the socket has
   connected. Two things follow. A connection that never completes, to an
   unroutable address or a host that drops packets, now fails at the
   timeout, where under Node it used to last as long as the operating
   system kept trying. And a response that trickles in for longer than the
   timeout now fails, where upstream let it run as long as bytes kept
   arriving.
2. **Shutdown ends what is in flight.** Stopping an exporter destroys its
   requests in flight, cancels its wait between two retries, and fails
   every later export at once. Upstream's transport does nothing when it is
   shut down.
3. **Shutdown destroys the agent**, which closes its idle keep-alive
   connections to the collector.
4. **Exports that start together share one agent.** Upstream builds an
   agent for each export that starts before the first agent exists, and
   keeps the last.
5. **A wait that is too long for a timer is clamped.** A `Retry-After`
   beyond 2147483647 ms, about 24.8 days, waits that long. Upstream's
   timer fires after a millisecond. A timeout that large is clamped the
   same way, which is also what upstream's amounts to.
6. **Under Bun a gzip body carries a `Content-Length`.** Upstream streams
   the compressed body, which Bun frames as chunked. This transport
   compresses the body in one call and then sends it, so Bun sends its
   length. Under Node both send a gzip body chunked, though the same bytes
   can be split into chunks differently. A body that is not compressed is
   framed the same by both on each runtime. A collector reads either
   framing.

Once `shutdown()` has resolved, the telemetry holds nothing that keeps
the process alive, with one exception. Under Node a name lookup in
progress cannot be cancelled. When the collector's host name does not
resolve and the resolver does not answer either, the export still fails on
time and `shutdown()` still resolves at its deadline, but the process
stays alive until the resolver gives up. That took 10 s in the review that
found it, and it depends on the resolver's own timeouts.

When the shutdown deadline passes with an export still in flight, the
export is abandoned and that signal is in the report. Its error is
`deadline exceeded`, unless another export of the same signal had already
failed, in which case the report carries that earlier error.

The export timeout defaults to 5000 ms for spans, logs and metrics, where
sdk-node uses 30000 ms, so a flush against a collector that does not
answer gives up when the default shutdown deadline does. An explicit
`OTEL_BSP_EXPORT_TIMEOUT`, `OTEL_BLRP_EXPORT_TIMEOUT` or
`OTEL_METRIC_EXPORT_TIMEOUT` still wins.

## Propagators

`OTEL_PROPAGATORS` selects the propagators when the `propagators` option
is not given: `tracecontext`, `baggage` and `none`, as a comma-separated
list applied in order. Unset or empty, it leaves the default,
`tracecontext,baggage`. Any other name, such as `b3` or `jaeger`, rejects
`setup` and `createTelemetry` with `O11yError` code
`UNSUPPORTED_PROPAGATOR`. Pass a propagator for it through the
`propagators` option. The
[core README](https://github.com/jamesainslie/libo11y/tree/main/ts/packages/core#options)
has the details.

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
  hook on `Module.prototype.require`, for `setup` and for `createTelemetry`
  alike. It installs the hook when it is constructed, although it patches
  no module. The hook stays for the life of the process, even after
  `shutdown()`. Pass `runtimeMetrics: false` to avoid it.
- A span's attributes are read by upstream's tracer. An attributes object
  that cannot be read, such as a revoked `Proxy`, throws from `startSpan`
  or `setAttributes`. The logger, wide records and metric instruments do
  not throw this way.
- OTLP over gRPC is not supported.

## Parity

[docs/PARITY.md](https://github.com/jamesainslie/libo11y/blob/main/docs/PARITY.md)
lists where the TypeScript packages match Go and where they differ, with
the reasons.
