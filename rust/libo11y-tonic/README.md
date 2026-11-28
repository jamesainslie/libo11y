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
  response trailers. An HTTP 200 response that ends without `grpc-status` was
  truncated and records `UNKNOWN` ("missing grpc-status trailer"), as tonic
  and grpc-go report it.
- Classifies transport and body errors as tonic's client does: a carried
  `tonic::Status` keeps its code, a refused or reset connection records
  `UNAVAILABLE`, an expired tonic timeout or a canceled stream `CANCELLED`, and
  an HTTP/2 reset maps by its reason. Boxed errors are looked through, and an
  error with nothing recognizable records `UNKNOWN`.
- A server call that ends `UNIMPLEMENTED` records `rpc.method` `_OTHER` on the
  span and the duration metric and renames the span `_OTHER`, so unrouted
  paths cannot create unbounded series.
- Supports `with_ignore_health_checks()`, `with_public_endpoint()`, and custom
  `with_filter(...)` predicates without touching process globals.

Licensed under the Apache License, Version 2.0.
