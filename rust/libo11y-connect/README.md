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
- Supports `with_ignore_health_checks()`, `with_public_endpoint()`,
  `with_filter(...)`, and `with_canonical_line()` (emitting
  `o11y.request.summary` enriched by `libo11y::Record`).

Licensed under the Apache License, Version 2.0.
