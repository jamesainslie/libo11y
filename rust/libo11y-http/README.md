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

## Error and cancellation attributes

- `url.scheme` is clamped to `http` or `https`, so a request target with an
  arbitrary scheme cannot create a new metric series.
- A service or body error records `error.type` as the error's type name
  without its module path, such as `DownstreamErr`. A boxed or trait-object
  error, such as `Box<dyn Error + Send + Sync>`, records `_OTHER`, since its
  type name says nothing about the error inside it.
- A request whose future is dropped before the response head is ready, on
  either layer, ends its span with `error.type` `canceled` and an error
  status, and records the duration with `error.type` `canceled` and no
  `http.response.status_code`. On the server, the canonical line reports
  status `499` (nginx's Client Closed Request) for such a request.

Licensed under the Apache License, Version 2.0.
