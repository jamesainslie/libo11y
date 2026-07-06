# Changelog

All notable changes to the libo11y Go module are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the module adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `o11y.Setup` and `o11y.New`: one-call OpenTelemetry pipeline construction
  (traces, metrics, logs over OTLP) returning an owned `SDK` handle with
  idempotent, per-signal-reporting `Shutdown` and `ForceFlush`.
- Standard `OTEL_*` environment configuration via autoexport and resource
  detection, with strict option-over-environment-over-default precedence
  and required `service.name` resolution.
- Correlated slog pipeline: console (JSON/text) and OTLP sinks behind one
  fan-out handler with full `slog.Handler` contract compliance, top-level
  `trace_id`/`span_id` on console records, uniform attribute replacer, and
  runtime-adjustable level.
- W3C Trace Context + Baggage propagation installed by default.
- Runtime metrics on by default; `WithHistogramBuckets` and `WithViews`
  for metric shaping.
- `o11yhttp`: route-aware net/http server and client instrumentation on
  stable HTTP semantic conventions, with path filtering and public-endpoint
  mode.
- `o11ygrpc`: gRPC server and client stats handlers.
- `redact`: capture-time protection (`Secret`, `Masked`, tag-driven
  `Struct` with mask/redact/omit, strictest-wins nesting, fail-closed
  unknown tags) across slog, fmt, and JSON surfaces.
- `o11ytest`: hermetic in-memory test harness recording spans, metrics,
  and correlated log records, safe under `t.Parallel()`.
- Runnable HTTP server example.
- Rust-client parity features: `ForceEmit` context marker for always-emit
  audit records; startup summary record doubling as an initialization
  canary (sink failures fail `Setup`) with `SDK.EffectiveConfig` accessor;
  build-info resource detector (module version and `vcs.*` stamp) and
  container detector; `SDK.ShutdownOnSignals` lifecycle helper;
  `o11ygin` Gin middleware as a nested module. Parity matrix in
  `docs/PARITY.md`.
