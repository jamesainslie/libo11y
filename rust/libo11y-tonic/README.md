# libo11y-tonic

OpenTelemetry tracing and metrics Tower layers for `tonic` gRPC servers and
clients, built on `libo11y` and following OpenTelemetry RPC semantic conventions
(v1.41.0).

- `ServerLayer::new(&sdk)` plugs directly into `tonic::transport::Server::builder().layer(...)`.
- `ClientLayer::new(&sdk)` plugs directly into `tower::ServiceBuilder::new().layer(...).service(channel)`.
- Emits `rpc.server.call.duration` and `rpc.client.call.duration` histograms
  through the SDK's exemplar-aware meter with trace-linked exemplars.
- Propagates W3C Trace Context and Baggage over HTTP/2 headers via `sdk.propagator()`.
- Reads `grpc-status` from both trailers-only response headers and HTTP/2
  response trailers.
- Supports `with_ignore_health_checks()`, `with_public_endpoint()`, and custom
  `with_filter(...)` predicates without touching process globals.

Licensed under the Apache License, Version 2.0.
