# Changelog

All notable changes to the C11 implementation (`c/`) are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-11-27

### Added

- Generated ISO C11 specification header (`c/include/o11y/spec.h`) via `go/internal/specgen` (spec 1.2.0, semconv v1.41.0).
- Core C11 ABI (`c/include/o11y/o11y.h`) built as `libo11y.a` and `libo11y.so`/`.dylib` over the libo11y Zig telemetry engine:
  - One-call `o11y_setup` / `o11y_init`, typed `o11y_err_t` + `o11y_diagnostic_t`, double-setup guard, startup canary, idempotent bounded concurrent shutdown, and `o11y_shutdown_on_signals`.
  - Explicit `o11y_ctx_t`, tracing (spans, events, links, status, samplers), metrics (sync and observable counters/up-down counters/histograms/gauges, histogram buckets, trace-based exemplars), structured logging (console JSON/text, OTLP fan-out, `force_emit`, attribute replacers, extra sinks), events, and wide-event `o11y_record_t`.
  - Unified sensitivity policy (`drop`/`hash`/`allow`), application attribute registry loading, and capture-time redaction helpers (`o11y_redact_secret`, `o11y_redact_mask`).
  - W3C TraceContext + Baggage propagation with baggage egress filter, detached work carriers (`o11y_detached_*`), and child-process environment propagation (`o11y_proc_*`).
  - OTLP/HTTP (`http/protobuf`, `http/json`, gzip) and OTLP/gRPC (HTTP/2 h2c and TLS ALPN `h2`, custom CA, mTLS).
- Self-contained C11 hermetic test harness (`libo11ytest.a`, `c/include/o11y/test.h`) with conformance, correlation, and triangle assertions plus in-process OTLP/HTTP and OTLP/gRPC receivers.
- `libo11y registry check` CLI binary, `pkg-config` (`libo11y.pc`), CMake config (`libo11yConfig.cmake`), and runnable C11 quickstart example.
- Full C11 unit, shared cross-language conformance, wire, and CLI test suites (`make c-check`).

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/c/v0.1.0...HEAD
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/c/v0.1.0
