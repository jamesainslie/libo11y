# Changelog

All notable changes to the Ruby implementation (`ruby/`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-28

### Added

- Core Ruby SDK (`Libo11y.setup`, `Libo11y.init`, `Options`, typed `Libo11y::Error` hierarchy, idempotent bounded concurrent shutdown, `shutdown_on_signals`). `shutdown` returns a `ShutdownReport` that names each signal that failed, missed the deadline, or had its final export rejected by the collector, and emits `o11y.telemetry.dropped` for each to the console and the extra sinks. `force_flush` flushes the three signals concurrently and returns `false` on the same failures. The `o11y.telemetry.configured` startup event carries the registry's attributes (`service.name`, `service.version`, `o11y.config.traces`, `metrics`, `logs`, `console`, `level`, `sampler`, `propagators`, `runtime_metrics`, and the sanitized endpoints), and `Telemetry#effective_config` returns them as one line. Explicit options and `resource_attributes` beat `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`. `OTEL_SDK_DISABLED=true` installs a tracer provider that records nothing. An empty per-signal `OTEL_EXPORTER_OTLP_*` variable falls back to the general one. `Libo11y.setup` claims its place before it builds anything, stops the workers of a start that fails, and raises `CanaryRejected` when a sink raises on the startup canary or the log exporter answers it with a failure.
- Generated spec constants, tables, and `GoPrint` ranges (`Libo11y::Spec`, spec 1.3.0) and strict `yaml.v3`-compatible application attribute registry validator passing all 46 shared conformance cases, plus `exe/libo11y registry check`.
- Single `SensitivityPolicy` across resource, spans, metrics (PII always dropped), and structured logs, matching all shared PII hash, instance ID, and endpoint sanitization conformance vectors. An injected span processor sees the redacted span through `attributes`, `events`, `links` and `to_span_data`. Observable instruments classify the attributes given to `add_attributes` and `observe`. A log record is classified once, so one PII value has one token on the console, on OTLP and on spans, and one violation is counted per record. The walk over nested log values drops what its depth bound, its budget of 2048 nodes or a cycle kept it from examining.
- Capture-time redaction (`Libo11y::Redact::Secret`, `Masked`, `Fields`), where the strictest protection wins through nesting and a subclass keeps its parent's field rules, wide events (`Record`), `force_emit`, detached propagation (`Libo11y::Detached`), child-process propagation (`Libo11y::Proc`), and zero-dependency Ruby/process runtime metrics.
- Integrations: `Libo11y::Rack::Middleware`, `Libo11y::HttpClient`, and `Libo11y::DB::Client`. The DB client removes literals and comments with the same dialect-aware lexer as `go/o11ysql` (PostgreSQL dollar quoting, escape strings and nested comments, MySQL backslash escapes, double-quoted strings, `#` and versioned comments, SQLite parameters), records `db.query.text` only for `postgresql`, `sqlite`, `mysql` and `mariadb`, capped at 4096 bytes, names the span after the operation and table, and never records a driver's error message.
- Hermetic test harness (`Libo11y::Testing::Recorder` and `OtlpHttpReceiver`). `OtlpHttpReceiver` serves through WEBrick, which the gem does not depend on. A consumer adds `gem "webrick"` to its test group.

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/ruby/v0.1.0...HEAD
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/ruby/v0.1.0
