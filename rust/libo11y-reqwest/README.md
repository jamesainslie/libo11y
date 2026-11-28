# libo11y-reqwest

`reqwest-middleware` client instrumentation for `libo11y`, following
OpenTelemetry HTTP semantic conventions 1.41.0.

- `O11yMiddleware::new(&sdk)` implements `reqwest_middleware::Middleware` using
  the SDK handle explicitly with no process globals.
- Injects W3C Trace Context and Baggage headers via `sdk.propagator()`.
- Emits `SpanKind::Client` spans with `http.request.method`, `url.full`
  (with userinfo stripped), `server.address`, `server.port`,
  `http.response.status_code`, and `error.type`.
- Records `http.client.request.duration` histograms in seconds through the
  SDK's exemplar-aware meter.
- Supports `with_filter(...)` and `with_ignore_paths(...)` (Go `path.Match`
  glob syntax).

Licensed under the Apache License, Version 2.0.
