# Changelog

All notable changes to the C11 implementation (`c/`) are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-11-28

### Added

- Spec 1.3.0 / semconv v1.41.0 alignment in generated `o11y/spec.h`.
- `O11Y_VERSION`, `O11Y_VERSION_MAJOR`, `O11Y_VERSION_MINOR`, and `O11Y_VERSION_PATCH` version macros in `o11y/o11y.h`, checked against `c/build.zig.zon`.
- `o11y_options_t.propagators` and `o11y_test_options_t.propagators` (`o11y_propagator_t`, `O11Y_PROPAGATOR_TRACE_CONTEXT`, `O11Y_PROPAGATOR_BAGGAGE`, and `O11Y_PROPAGATOR_CUSTOM`), `OTEL_PROPAGATORS` parsing, `O11Y_ERR_UNSUPPORTED_PROPAGATOR`, and per-SDK `baggage_egress_allow_userdata`.
- `o11y_attr_replacement_t` with `o11y_attr_replacement_set_key` and `o11y_attr_replacement_set_value` for safe deep-copied key and typed-value replacement inside `o11y_attr_replacer_fn`.
- Pre-1.0 minor-versioned shared library SONAME/install_name (`libo11y.so.0.Y` / `@rpath/libo11y.0.Y.dylib`) with ELF version script and `-Wl,-z,nodelete` restricting exports to `o11y_*`, Darwin `nm -gU` export verification, non-executable `GNU_STACK`, relative symlinks, relocatable `pkg-config`, and cache-free CMake targets `libo11y::o11y`, `libo11y::o11y_shared`, `libo11y::o11y_static`, `libo11y::o11ytest`, and `libo11y::o11ytest_static` with pointer-width checking.
- ABI layout test (`c/src/abi_layout_test.zig`), including C11/C++11 static enum size assertions in `o11y/o11y.h`, verifying `c/src/c_types.zig` structs, unions, and enums against the C11 headers, plus Zig `abi-unit` trampoline OOM tests.
- Multi-threaded C11 concurrency suite (`c/tests/test_concurrency.c`) and ASan/UBSan test runner (`c/tests/run_sanitized.sh`, `make c-sanitize`, wired into `make c-check`).

### Changed

- Breaking: Split `libo11ytest.a` into a companion archive exporting only `o11y_test_*` (`Requires: libo11y` in `libo11ytest.pc`, linking `libo11y::o11y` or `libo11y::o11y_static` in CMake) so test binaries link cleanly alongside either `libo11y.a` or `libo11y.so`/`.dylib` with no duplicate symbols.
- Breaking: Added `struct_size` as the first field on `o11y_options_t` and `o11y_test_options_t`; zero-initialized or mismatched structs are rejected with `O11Y_ERR_INVALID_ARGUMENT`.
- Breaking: `o11y_baggage_egress_allow_fn` now takes `(void *userdata, const char *key)` and runs per SDK instead of through a process-global slot.
- Breaking: `o11y_attr_replacer_fn` now passes an opaque `o11y_attr_replacement_t *` handle mutated via `o11y_attr_replacement_set_key` and `o11y_attr_replacement_set_value` instead of raw caller pointers, failing closed when replacement allocation or validation fails.
- Breaking: Removed 5 unreachable `o11y_err_t` constants (`O11Y_ERR_NOT_FOUND`, `O11Y_ERR_PARSE`, `O11Y_ERR_CONFORMANCE`, `O11Y_ERR_CORRELATION`, `O11Y_ERR_VIOLATIONS`) and renumbered `O11Y_ERR_IO = 15`.
- Breaking: ELF shared library uses minor-versioned SONAME `libo11y.so.0.Y` before `1.0` instead of `libo11y.so.0`.
- Unknown option enum values, `O11Y_CONSOLE_CUSTOM` without `console_write_fn`, non-zero-length slices with `NULL` pointers (including `o11y_detached_unmarshal` and `o11y_sanitize_endpoint`), and partial test TLS cert/key pairs now fail with `O11Y_ERR_INVALID_ARGUMENT`.
- `o11y_shutdown_on_signals` rejects signal counts above 16, `NULL` arrays with non-zero length, `SIGKILL`/`SIGSTOP`, `sigaction` failures, and signal numbers outside 1 to 64 with `O11Y_ERR_INVALID_ARGUMENT`, and runs on the owning SDK's I/O handle.
- `o11y_shutdown(NULL, ...)` and `o11y_force_flush(NULL, ...)` return `O11Y_OK` with an all-OK report, and `o11y_force_flush` sequentially flushes logs, metrics, and traces under one shared deadline.
- `libo11y` CLI now matches Go, TypeScript, and Rust (`-h`/`--help`/`help` exits 0 to stdout, violations go to stdout, Go-style read/parse errors go to stderr, no 4 MiB file cap).
- Updated `c/README.md`, `c/examples/quickstart.c`, `docs/PARITY.md` C cells, and Linux LLVM archive generation to eliminate executable-stack notes.

### Fixed

- Isolated hermetic handles (`O11Y_ENV_HERMETIC` SDKs, `o11y_record_create`, `o11y_test_start`) onto signal-free synchronous/`hermetic_io` runtimes and ref-counted networked `std.Io.Threaded` (`acquireIo`/`releaseIo`) so host `SIGIO`/`SIGPIPE` handlers already installed or changed while live are preserved, `o11y_record_create` touches no global mutex or signal handler, and `std_options.signal_stack_size = null` leaves host/ASan `sigaltstack` untouched.
- Added Darwin `_NSGetEnviron()` support and restricted `O11Y_ENV_PROCESS` to a scratch `OTEL_*`-only snapshot freed at the end of setup.
- Failed closed (`null`) on cyclic, over-depth (`depth >= 16`), or over-budget composite log attributes without emitting JSON `null`; fixed `o11y_pii_hash_value` wide-map UTF-8 key sort stability, full container length preservation, and exact depth-20 truncation parity; made `LogSinkTrampoline` fail closed with `error.SinkRejected` on OOM; guarded `EngineCarrierBridge` against NULL keys/values; reported `"custom"` fallback for fieldless custom propagators; zeroed out-parameters on entry; rejected post-shutdown observable registration; clamped non-finite/out-of-range doubles in `o11y_test_metric_sum_i64`; matched `o11y_test_violations` signals strictly; made `o11y_record_set_error` atomic.
- Added `RecorderHandle.str_mutex` around zero-copy span/log recorder queries and string caches, copied `trace_state` into `o11y_test_span_parent_context` and `o11y_test_log_span_context`, enforced W3C baggage validation and item bounds, copied carrier `get()` strings before the next key lookup, and fixed `o11y_tracer_start`/`o11y_detached_start_linked` OOM return.
- Eliminated memory leaks on failed `o11y_setup`, `o11y_init`, `o11y_test_start`, observable metric callbacks (`o11y_shutdown` + `o11y_test_destroy`), and disabled bundled UBSan runtime in static/shared libraries.

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

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/c/v0.2.0...HEAD
[0.2.0]: https://github.com/jamesainslie/libo11y/compare/c/v0.1.0...c/v0.2.0
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/c/v0.1.0
