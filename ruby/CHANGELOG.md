# Changelog

All notable changes to the Ruby implementation (`ruby/`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-28

### Added

- Core Ruby SDK (`Libo11y.setup`, `Libo11y.init`, `Options`, typed `Libo11y::Error` hierarchy, idempotent bounded concurrent shutdown, `shutdown_on_signals`).
- Generated spec constants, tables, and `GoPrint` ranges (`Libo11y::Spec`, spec 1.3.0) and strict `yaml.v3`-compatible application attribute registry validator passing all 46 shared conformance cases, plus `exe/libo11y registry check`.
- Single `SensitivityPolicy` across resource, spans, metrics (PII always dropped), and structured logs, matching all shared PII hash, instance ID, and endpoint sanitization conformance vectors.
- Capture-time redaction (`Libo11y::Redact::Secret`, `Masked`, `Fields`), wide events (`Record`), `force_emit`, detached propagation (`Libo11y::Detached`), child-process propagation (`Libo11y::Proc`), and zero-dependency Ruby/process runtime metrics.
- Integrations: `Libo11y::Rack::Middleware`, `Libo11y::HttpClient`, and `Libo11y::DB::Client`.
- Hermetic test harness (`Libo11y::Testing::Recorder` and `OtlpHttpReceiver`). `OtlpHttpReceiver` serves through WEBrick, which the gem does not depend on. A consumer adds `gem "webrick"` to its test group.

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/ruby/v0.1.0...HEAD
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/ruby/v0.1.0
