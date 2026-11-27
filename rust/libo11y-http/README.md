# libo11y-http

Tower HTTP server and client instrumentation layers for `libo11y`, following
OpenTelemetry HTTP semantic conventions 1.41.0 and matching Go's `o11yhttp`
contract.

- `ServerLayer::new(&sdk)` instruments any `tower::Service<http::Request<B>>`:
  route-aware span names, W3C Trace Context and Baggage extraction,
  `with_public_endpoint()`, `with_ignore_paths(...)` (Go `path.Match` globs),
  `with_filter(...)`, `with_canonical_line()` (`o11y.request.summary` wide
  events enriched via `libo11y::record_from_context`), panic recording, and
  `http.server.request.duration` histograms with exemplars.
- Optional `axum` feature reads `axum::extract::MatchedPath` automatically when
  no custom route extractor matches.
- `ClientLayer::new(&sdk)` instruments outbound `tower::Service` clients with
  W3C propagation injection, `SpanKind::Client` spans, userinfo stripping on
  `url.full`, and `http.client.request.duration` histograms with exemplars.

This crate is in progress and has not been published yet.

Licensed under the Apache License, Version 2.0.
