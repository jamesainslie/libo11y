# Changelog

All notable changes to the C11 implementation (`c/`) are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `O11Y_VERSION`, `O11Y_VERSION_MAJOR`, `O11Y_VERSION_MINOR`, and `O11Y_VERSION_PATCH` version macros in `o11y/o11y.h`, checked against `c/build.zig.zon`.
- `o11y_options_t.propagators` and `o11y_test_options_t.propagators` (`o11y_propagator_t`, `O11Y_PROPAGATOR_TRACE_CONTEXT`, `O11Y_PROPAGATOR_BAGGAGE`, and `O11Y_PROPAGATOR_CUSTOM`) with per-SDK `baggage_egress_allow_userdata`.
- Versioned shared library output (`libo11y.so.X.Y.Z` / `libo11y.X.Y.Z.dylib`), relocatable `libo11y.pc` and `libo11ytest.pc`, and `libo11yConfigVersion.cmake`.
- ABI layout test (`c/src/abi_layout_test.zig`) verifying `c/src/c_types.zig` structs, unions, and enums against the C11 headers.
- ASan/UBSan test runner (`c/tests/run_sanitized.sh`, `make c-sanitize`, wired into `make c-check`).

### Changed

- `o11y_baggage_egress_allow_fn` now takes `(void *userdata, const char *key)` and runs per SDK instead of through a process-global slot.
- Unknown option enum values and `O11Y_CONSOLE_CUSTOM` without `console_write_fn` now fail setup with `O11Y_ERR_INVALID_ARGUMENT` and a diagnostic message instead of falling back to defaults.
- `o11y_shutdown_on_signals` rejects signal counts above 16, `NULL` arrays with non-zero length, and signal numbers outside 1 to 64 with `O11Y_ERR_INVALID_ARGUMENT`.
- Removed unused `o11y_registration_t` forward declaration from `o11y/o11y.h`.
- Updated `c/README.md` with ownership, threading, configuration, per-signal guarantees, documented policy gaps, and the aligned three-signal checkout quickstart.

### Fixed

- Eliminated memory leaks on failed `o11y_setup`, `o11y_init`, `o11y_test_start`, and observable metric callback registrations.
- Context handles (`o11y_ctx_t`) now copy span context trace state and baggage so contexts outlive parent contexts and ended spans.
- `o11y_span_context`, `o11y_ctx_baggage_get`, and `o11y_detached_span_context` no longer mutate handle state during const reads.
- `o11y_setup`, `o11y_init`, and `o11y_test_start` clear `o11y_diagnostic_t` on entry.
- Disabled bundled UBSan runtime in `libo11y.a`, `libo11y.so`/`.dylib`, and `libo11ytest.a` so built libraries export no `__ubsan_*` symbols.
- Replaced fixed sleep in `test_shutdown_on_signals` with handler-installation polling to remove timing flakiness.

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
