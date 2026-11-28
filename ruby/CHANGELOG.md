# Changelog

All notable changes to the Ruby implementation (`ruby/`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `Telemetry#shutdown(timeout:)` holds to its deadline in every case. A caller that waits on a shutdown another thread started gets a report at its own deadline, with the error "shutdown is still in progress". Writing the `o11y.telemetry.dropped` events is bounded too, so a console or extra sink that blocks no longer holds shutdown open.
- `Libo11y.shutdown_on_signals` gives `before_shutdown` and the shutdown one shared deadline. A callback that outlives it is left behind, and a callback that raises still gets the shutdown, then its error.
- An OTLP endpoint that is not an absolute `http` or `https` URL with a host fails `setup` and `init` with `Libo11y::ExporterError`. The message names the variable and never the value. 0.2.0 let `URI::InvalidURIError` or an exporter's own error through.
- `Testing::Recorder` raises `ArgumentError` for `env`, `span_exporter`, `metric_reader`, `log_exporter` and `console_writer`, which it sets itself. 0.2.0 accepted them, and the recorder then read sinks that held nothing.
- `Rack::Middleware` matches `ignore_paths` as Go's `path.Match` does: `*` and `?` stop at a slash, `**` has no recursive meaning, and a malformed pattern matches nothing. 0.2.0 used `File.fnmatch`, whose `**` and escapes differ.

### Fixed

- `Telemetry#inspect`, `Options#inspect` and the sensitivity policy's `inspect` printed the `pii_hash_key`. They now print the effective-config line, the options with the key filtered, and the PII mode.
- An injected span processor could read the unredacted span: 0.2.0 handed it a view that kept the SDK span reachable. It now gets a finished span that holds the classified data only. With several injected processors each violation is counted once, where 0.2.0 counted it once per processor.
- A meter taken from `OpenTelemetry.meter_provider` before `Libo11y.setup` raised `ArgumentError` on its first instrument after setup, because the wrapped meter did not take the options the OpenTelemetry API passes on. A `setup` that fails while it installs the globals now puts back the ones it had replaced.
- `HttpClient` recorded `http.client.request.duration` after the client span had left the context, so the measurement's exemplar named the caller's span. It is recorded inside the client span.
- `Telemetry#logger` did not answer `Logger#log`, which Ruby defines as an alias of `add`, so `logger.log(Logger::INFO, "x")` wrote to the base logger's nil device and nothing reached a sink.
- A log attribute holding a list of hashes or lists with a `NaN` or infinite float raised inside the logger on its way to OTLP, and the record was lost. Such a float is written as `"NaN"`, `"+Inf"` or `"-Inf"`, as it already was on the console.
- The registry YAML reader read a quoted scalar that follows a tag or an anchor, such as `!!str "a\x41"`, as a plain scalar, so an escape `yaml.v3` rejects was accepted.
- `Rack::Middleware` added `Server-Timing` to any response whose content type began with `text/html`, such as `text/html5`. The media type must be `text/html`.

### Added

- The release check asserts the specification's schema URL on the resource of each signal and a metric exemplar that names the span, on the installed gem over OTLP.

## [0.2.0] - 2026-11-28

This release fixes most of what the first review of 0.1.0 found. It changes an option name, a return type and the text form of a carrier, so read the "Changed" list before upgrading.

### Changed

- The `console_level` option is now `log_level`, as in the other libo11y implementations. It sets the level of `Telemetry#logger`, which gates the console, OTLP and the extra sinks alike. In 0.1.0 setting `level` on the logger had no effect.
- `Telemetry#effective_config` returns one frozen line of `key=value` pairs, as Go and Python do. 0.1.0 returned a Hash.
- The `o11y.telemetry.configured` startup event carries the attributes the registry defines: `service.name`, `service.version`, `o11y.config.traces`, `o11y.config.metrics`, `o11y.config.logs`, `o11y.config.console`, `o11y.config.level`, `o11y.config.sampler`, `o11y.config.propagators`, `o11y.config.runtime_metrics`, `o11y.config.service_version_fallback` and the sanitized endpoints. 0.1.0 wrote keys such as `o11y.config.traces.exporter` that the registry does not define.
- `Detached::Carrier` writes and reads the URL-encoded text form of the other libo11y implementations (`baggage=...&traceparent=...&tracestate=...`), so a carrier crosses to a Go or Python worker. 0.1.0 wrote JSON, and a carrier that 0.1.0 serialized is not read. `Carrier` exposes `traceparent`, `tracestate`, `baggage`, `span_context` and `zero?` in place of `headers`. `start_linked` starts an `internal` span by default.
- `Proc.child_env` takes an empty base environment by default and maps `TRACEPARENT` and `TRACESTATE` to `nil` when the active span does not set them, so `Process.spawn` removes a stale value from the child.
- Explicit options and `resource_attributes` beat `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`. In 0.1.0 the environment beat `service.name` and `deployment.environment.name` given in `resource_attributes`.
- An injected span processor owns the export path, as an injected exporter does, so no exporter is built from the environment beside it.
- `Libo11y.force_emit` and `Libo11y.start_record` need a block and raise `ArgumentError` without one. In 0.1.0 a call without a block left its scope open for the rest of the thread.
- `Libo11y.setup` and `Libo11y.init` lay keywords over an `Options` object given with them, and raise `ArgumentError` for a keyword that is not an option. In 0.1.0 keywords beside an `Options` object were dropped without a word.
- In the `app_registries` option a `String` of one line is a path and a `Pathname` is always one. A path that does not exist raises `InvalidAppRegistry` with the missing file's name, where 0.1.0 reported a YAML type error.
- `Libo11y::InvalidEnvironment` names the value and the allowed set, and `Libo11y::CanaryRejected` says "rejected by log pipeline", as Go's errors do.
- `Rack::Middleware` adds the `Server-Timing` entry to HTML responses only, as the Go middleware does, and raises `ArgumentError` for `canonical_line: true` without `telemetry:`, where it used to emit nothing.

### Fixed

- `shutdown` reported success when the collector rejected a signal's final export. The `ShutdownReport` now names each signal that failed, missed the deadline, or had an export rejected, and an `o11y.telemetry.dropped` event for each goes to the console and the extra sinks.
- `shutdown` with a timeout that is not a number raised and left every later caller waiting. It now raises `ArgumentError` before it claims the shutdown.
- `force_flush` flushed the signals one after another and always returned `true`. It flushes them concurrently under one deadline and returns `false` when one fails.
- `Libo11y.setup` let two concurrent callers both build providers, and a start that failed left its workers running. It claims its place before it builds anything and stops what a failed start built.
- The startup canary did not fail `setup` when the log exporter answered with a failure or raised.
- Under `OTEL_SDK_DISABLED=true` the tracer provider recorded spans and minted trace ids. It records nothing and passes an inbound trace context through.
- An empty per-signal `OTEL_EXPORTER_OTLP_*` variable hid the general one.
- Percent escapes in `OTEL_RESOURCE_ATTRIBUTES` and in OTLP headers decode as UTF-8.
- A `Float::NAN` or infinite attribute raised out of the logging call. It is written to the console as `"NaN"`, `"+Inf"` or `"-Inf"`, and a console that fails no longer stops the other sinks.
- `Detached.capture` returns the zero carrier outside a span and drops the trace state and then the baggage to stay within 32 KiB. `Carrier.unmarshal_text` refuses text with no valid traceparent.
- `Detached.start_linked` dropped the caller's baggage. It merges the carrier's baggage into it.
- The baggage egress filter dropped the metadata of the members it let through.
- The Rack middleware and `HttpClient` record a request method outside the standard set as `_OTHER`, with the method as given in `http.request.method_original`, so a caller cannot grow the metric's series. `HttpClient` sends such a method, where it used to raise.
- A raised error is recorded on the span once, and the span status carries no error message. A 5xx response sets `error.type` on the span, the metric and the canonical line.
- The Rack middleware keeps an existing `Server-Timing` value in the form the application set it, a list included, and does not add a second header under another case.
- A request the middleware ignores no longer clears the route an enclosing middleware set. Ignore patterns match a leading dot, as Go's `path.Match` does.
- `HttpClient` replaces a propagation header the caller passed in another case.
- Threads that share a middleware or a client create its histogram once.
- OTLP payloads carry the specification's schema URL on the resource of every signal. The upstream exporters do not write it, so libo11y adds it as each request is sent.
- The HTTP and DB duration histograms use their latency boundaries. The SDK ignores the boundaries an instrument advises, so libo11y registers a view for each, and `histogram_buckets` replaces one by name.
- The `views` option is applied. It takes Hashes of `MeterProvider#add_view` arguments with a `:name`. In 0.1.0 it did nothing.
- With `env: Libo11y::HERMETIC` or an explicit `env`, the span and log record limits, the batch processors' worker switch, and the exporters' certificate files and certificate verification no longer come from the process environment.
- Two registries that declare one namespace are refused also when they are given as compiled registries.
- The registry parser checks the escapes of a double-quoted scalar that follows an apostrophe in a plain or block scalar. It used to treat the apostrophe as an open quote, so `"a \/ b"` was accepted there and `"it the log record and the exemplar were on different traces. It requires one trace with a span, a log record and an exemplar, and takes a metric name to look at one metric's exemplars.
- `Recorder#assert_conforms!` passed after the code under test emitted a secret, because the secret had been redacted. It now fails on any counted redaction of a secret, as Go's `AssertConforms` does, looks at metric data points too, and lists every problem it finds.

## [0.1.0] - 2026-11-28

### Added

- Core Ruby SDK (`Libo11y.setup`, `Libo11y.init`, `Options`, typed `Libo11y::Error` hierarchy, idempotent bounded concurrent shutdown, `shutdown_on_signals`).
- Generated spec constants, tables, and `GoPrint` ranges (`Libo11y::Spec`, spec 1.3.0) and strict `yaml.v3`-compatible application attribute registry validator passing all 46 shared conformance cases, plus `exe/libo11y registry check`.
- Single `SensitivityPolicy` across resource, spans, metrics (PII always dropped), and structured logs, matching all shared PII hash, instance ID, and endpoint sanitization conformance vectors. An injected span processor sees the redacted span through `attributes`, `events`, `links` and `to_span_data`. Observable instruments classify the attributes given to `add_attributes` and `observe`. A log record is classified once, so one PII value has one token on the console, on OTLP and on spans, and one violation is counted per record. The walk over nested log values drops what its depth bound, its budget of 2048 nodes or a cycle kept it from examining.
- Capture-time redaction (`Libo11y::Redact::Secret`, `Masked`, `Fields`), where the strictest protection wins through nesting and a subclass keeps its parent's field rules, wide events (`Record`), `force_emit`, detached propagation (`Libo11y::Detached`), child-process propagation (`Libo11y::Proc`), and zero-dependency Ruby/process runtime metrics.
- Integrations: `Libo11y::Rack::Middleware`, `Libo11y::HttpClient`, and `Libo11y::DB::Client`. The DB client removes literals and comments with the same dialect-aware lexer as `go/o11ysql` (PostgreSQL dollar quoting, escape strings and nested comments, MySQL backslash escapes, double-quoted strings, `#` and versioned comments, SQLite parameters), records `db.query.text` only for `postgresql`, `sqlite`, `mysql` and `mariadb`, capped at 4096 bytes, names the span after the operation and table, and never records a driver's error message.
- Hermetic test harness (`Libo11y::Testing::Recorder` and `OtlpHttpReceiver`). `OtlpHttpReceiver` serves through WEBrick, which the gem does not depend on. A consumer adds `gem "webrick"` to its test group.

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/ruby/v0.2.0...HEAD
[0.2.0]: https://github.com/jamesainslie/libo11y/compare/ruby/v0.1.0...ruby/v0.2.0
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/ruby/v0.1.0
s"` was refused.
- `exe/libo11y` prints its usage on standard output and exits 0 for `-h`, `--help` and `help`, as the Go command does.
- Resident memory is computed with the system's page size, not a fixed 4 KiB.
- `OtlpHttpReceiver` returns copies of what it has received, taken under its lock.
- The gem declares its dependency on `logger`, which stops being a default gem in Ruby 3.5.
- `Recorder#assert_triangle!` passed when the log record and the exemplar were on different traces. It requires one trace with a span, a log record and an exemplar, and takes a metric name to look at one metric's exemplars.
- `Recorder#assert_conforms!` passed after the code under test emitted a secret, because the secret had been redacted. It now fails on any counted redaction of a secret, as Go's `AssertConforms` does, looks at metric data points too, and lists every problem it finds.

## [0.1.0] - 2026-11-28

### Added

- Core Ruby SDK (`Libo11y.setup`, `Libo11y.init`, `Options`, typed `Libo11y::Error` hierarchy, idempotent bounded concurrent shutdown, `shutdown_on_signals`).
- Generated spec constants, tables, and `GoPrint` ranges (`Libo11y::Spec`, spec 1.3.0) and strict `yaml.v3`-compatible application attribute registry validator passing all 46 shared conformance cases, plus `exe/libo11y registry check`.
- Single `SensitivityPolicy` across resource, spans, metrics (PII always dropped), and structured logs, matching all shared PII hash, instance ID, and endpoint sanitization conformance vectors. An injected span processor sees the redacted span through `attributes`, `events`, `links` and `to_span_data`. Observable instruments classify the attributes given to `add_attributes` and `observe`. A log record is classified once, so one PII value has one token on the console, on OTLP and on spans, and one violation is counted per record. The walk over nested log values drops what its depth bound, its budget of 2048 nodes or a cycle kept it from examining.
- Capture-time redaction (`Libo11y::Redact::Secret`, `Masked`, `Fields`), where the strictest protection wins through nesting and a subclass keeps its parent's field rules, wide events (`Record`), `force_emit`, detached propagation (`Libo11y::Detached`), child-process propagation (`Libo11y::Proc`), and zero-dependency Ruby/process runtime metrics.
- Integrations: `Libo11y::Rack::Middleware`, `Libo11y::HttpClient`, and `Libo11y::DB::Client`. The DB client removes literals and comments with the same dialect-aware lexer as `go/o11ysql` (PostgreSQL dollar quoting, escape strings and nested comments, MySQL backslash escapes, double-quoted strings, `#` and versioned comments, SQLite parameters), records `db.query.text` only for `postgresql`, `sqlite`, `mysql` and `mariadb`, capped at 4096 bytes, names the span after the operation and table, and never records a driver's error message.
- Hermetic test harness (`Libo11y::Testing::Recorder` and `OtlpHttpReceiver`). `OtlpHttpReceiver` serves through WEBrick, which the gem does not depend on. A consumer adds `gem "webrick"` to its test group.

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/ruby/v0.2.0...HEAD
[0.2.0]: https://github.com/jamesainslie/libo11y/compare/ruby/v0.1.0...ruby/v0.2.0
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/ruby/v0.1.0
