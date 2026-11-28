# libo11y-connect

OpenTelemetry tracing, metrics, and canonical log line instrumentation for
`connectrpc` servers and clients, built on `libo11y` and following OpenTelemetry
RPC semantic conventions (v1.41.0).

- `ServerInterceptor::new(&sdk)` implements `connectrpc::Interceptor` and plugs
  directly into `ConnectRpcService::new(router).with_interceptor(...)`.
- `ServerLayer::new(&sdk)` provides a Tower `Layer` for HTTP-level server
  instrumentation around `ConnectRpcService` or Axum routers.
- `ClientLayer::new(&sdk)` provides both a Tower `Layer` (for `ServiceTransport`)
  and `ClientLayer::wrap_transport(...)` returning an `InstrumentedTransport`
  implementing `connectrpc::client::ClientTransport` directly.
- Emits `rpc.server.call.duration` and `rpc.client.call.duration` histograms
  through the SDK's exemplar-aware meter with trace-linked exemplars.
- A gRPC response that ends with HTTP 200 and no `grpc-status` was truncated
  and records `UNKNOWN`. A Connect unary error without a JSON code maps its
  HTTP status per the Connect protocol table, every unlisted status reading
  `UNKNOWN`.
- Transport and body errors keep the code of a `ConnectError` they carry, and
  I/O failures map by kind. Anything else records `UNAVAILABLE`.
- A server call that ends `UNIMPLEMENTED` records `rpc.method` `_OTHER` on the
  span and the duration metric and renames the span `_OTHER`, and the canonical
  line's `http.request.method` is normalized to the known methods or `_OTHER`,
  so unrouted paths and methods cannot create unbounded series.
- Supports `with_ignore_health_checks()`, `with_public_endpoint()`,
  `with_filter(...)`, and `with_canonical_line()` (emitting
  `o11y.request.summary` enriched by `libo11y::Record`).

Licensed under the Apache License, Version 2.0.
