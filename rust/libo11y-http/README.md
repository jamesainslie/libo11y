# libo11y-http

Tower HTTP server and client instrumentation layers for `libo11y`, following
OpenTelemetry HTTP semantic conventions 1.41.0 and matching Go's `o11yhttp`
contract.

- `ServerLayer::new(&sdk)` instruments any `tower::Service<http::Request<B>>`:
  route-aware span names, W3C Trace Context and Baggage extraction,
  `with_public_endpoint()`, `with_ignore_paths(...)` (Go `path.Match` globs),
  `with_filter(...)`, `with_canonical_line()` (`o11y.request.summary` wide
  events enriched via `libo11y::record_from_context`), `with_server_timing()`
  (`Server-Timing: traceparent;desc="..."` on `text/html` responses), panic
  recording, and `http.server.request.duration` histograms with exemplars.
  Spans, duration metrics, and canonical lines finish when the response body
  ends, errors, panics, or drops.
- Optional `axum` feature reads `axum::extract::MatchedPath` automatically when
  no custom route extractor matches.
- `ClientLayer::new(&sdk)` instruments outbound `tower::Service` clients with
  W3C propagation injection, `SpanKind::Client` spans, userinfo stripping on
  `url.full`, and `http.client.request.duration` histograms with exemplars.

Licensed under the Apache License, Version 2.0.
