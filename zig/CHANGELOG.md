# Changelog

All notable changes to the libo11y Zig package (`libo11y-zig`, distributed
through the root `build.zig` and `build.zig.zon` shim from a `zig/vX.Y.Z`
tag) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package
adheres to [Semantic Versioning](https://semver.org/).

Requires Zig 0.17.1.

## [Unreleased]

### Added

- `o11y`: the `o11y.identity`, `o11y.pii`, `o11y.endpoint`, and
  `o11y.appregistry` namespaces are public. They hold the
  `service.instance.id` derivation, the canonical PII rendering and HMAC
  token, the endpoint sanitizer, and the application registry loader and
  validator.
- `o11y`: `Options.sdk_language`, `Options.sdk_version`, and
  `Options.emit_process_runtime` let a language binding built on this
  package, such as the C library, report its own `telemetry.sdk.*` values
  and leave out `process.runtime.*`. `o11ytest.Options` has the same fields.

### Changed

- `o11y.spec` is generated from spec 1.3.0. `spec.schema_url` is
  `https://schemas.o11y.ing/libo11y/1.3.0`, so every resource carries that
  schema URL. The module gains the RUM view summary, detail, and span shape
  attribute keys and the enums `RumSpanShape`, `RumResourceType`,
  `RumVitalAttributionInteractionType`, and `RumVitalAttributionLoadState`.

### Fixed

- `Telemetry.shutdown` and `Telemetry.forceFlush` report a trace or log
  batch the exporter rejects while they run. The batch processors handed a
  failed export to the error handler only, so a shutdown whose final batch
  the collector rejected returned a clean report. The error handler still
  receives each failure.
- A second `Telemetry.shutdown` caller stops waiting when its own timeout
  passes and gets `error.Timeout` for every signal. It waited for the first
  caller without a bound.
- The OTLP/HTTP and OTLP/gRPC transports no longer run a network attempt
  inline when the `Io` has no concurrent task left. An inline read could
  outlive the export deadline. The attempt now counts as a retryable
  failure, so the send ends by its deadline.

## [0.1.0] - 2026-11-26

### Added

- `o11y`: core OpenTelemetry SDK and pipeline built in Zig 0.17.1 over
  vendored `opentelemetry-proto` bindings (`zig-protobuf` runtime) and
  `tls.zig` for TLS/mTLS with ALPN.
- `o11y`: `o11y.setup` (installs process globals, the `std.log` route,
  double-setup guard, and runs the startup canary) and `o11y.init`
  (independent, global-free SDK for parallel tests and dependency injection),
  both returning an owned `*o11y.Telemetry` with closed error set
  `o11y.SetupError` and optional `*o11y.Diagnostic` text matching Go's
  messages.
- `o11y`: explicit `o11y.Env` (`.hermetic`, `.map`, `.pairs`, `.entries`)
  so libo11y never reads ambient process environment variables on its own;
  full `OTEL_*` environment configuration including `OTEL_SDK_DISABLED`,
  `OTEL_{TRACES,METRICS,LOGS}_EXPORTER`, `OTEL_EXPORTER_OTLP_*`,
  `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`,
  `OTEL_METRICS_EXEMPLAR_FILTER`,
  `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`, `OTEL_BSP_*`,
  `OTEL_BLRP_*`, and `OTEL_METRIC_EXPORT_*`.
- `o11y`: OTLP/HTTP (`http/protobuf` default and `http/json` via libo11y's
  own OTLP/JSON codec) and OTLP/gRPC over libo11y's own unary HTTP/2 client
  (h2c and TLS with ALPN `h2`, HPACK decoding with Huffman and dynamic
  table), with gzip compression, per-signal endpoints, headers, timeouts,
  bounded retries with exponential backoff, and CA/mTLS support.
- `o11y`: explicit immutable `o11y.Context` carrying span context, live span,
  baggage, `forceEmit` flag, and wide-event `o11y.Record`; W3C TraceContext
  and W3C Baggage propagation wrapped with an inject-only baggage egress
  filter (`baggage_egress_allow`).
- `o11y`: traces (`Tracer`, `Span` value handle, always-on, always-off,
  trace-ID ratio, and parent-based samplers, simple and batch span
  processors), metrics (`Counter`, `UpDownCounter`, `Histogram`, `Gauge`,
  observable variants, views, histogram bucket overrides, cumulative and
  delta temporality, 2000-series cardinality cap with overflow series,
  aligned-histogram and simple fixed-size exemplar reservoirs with
  trace-based, always-on, and always-off filters), and logs (structured
  `Logger` with console JSON/text and OTLP fan-out, `AttrReplacer`,
  `extra_log_sinks`, `o11y.forceEmit`, and `std.log` bridge via
  `o11y.std_options` and opt-in `o11y.bindThread`).
- `o11y`: tiered resource identity enforcement (`service.name`,
  enum-validated `deployment.environment.name`, `0.0.0-unknown` version
  fallback), `service.instance.id` derivation matching
  `conformance/vectors/instance-id.json`, single `spec.schema_url`
  (`https://schemas.o11y.ing/libo11y/1.2.0`), container ID detection, and
  `libo11y.addBuildInfo` build helper (`service.version`,
  `vcs.ref.head.revision`, `o11y.build.time`, `o11y.build.modified`).
- `o11y`: generated specification module `o11y.spec` (spec 1.2.0, semconv
  v1.41.0), unified key-based sensitivity policy across all signals (secrets
  always dropped, PII dropped by default, keyed HMAC-SHA256 tokens in hash
  mode matching `conformance/vectors/pii-hash.json`, PII always dropped on
  metrics and exemplars, `o11y.schema.violations` self-metric), and strict
  YAML parser and validator for application attribute registries
  (`app_registries`).
- `o11y`: capture-time redaction types `o11y.redact.Secret(T)`,
  `o11y.redact.Masked(T)`, and `o11y.redact.Struct(T)` with comptime tag
  validation (`mask`, `confidential`, `redact`, `secret`, `omit`; unknown
  tags fail at compile time) guarding `std.fmt`, `std.json`, and the logger.
- `o11y`: registered event API (`Telemetry.event`), wide events
  (`o11y.Record`, `o11y.startRecord`, `o11y.recordFromContext`), startup
  canary (`o11y.telemetry.configured`), `Telemetry.effectiveConfig()` with
  sanitized endpoints (`conformance/vectors/endpoint-sanitize.json`),
  detached work propagation (`o11y.detached`), child-process and framed-socket
  propagation (`o11y.proc`), semantic-convention process metrics
  (`process.cpu.time`, `process.memory.usage`, `process.memory.virtual`,
  `process.thread.count`, `process.unix.file_descriptor.count` on Linux and
  macOS), and bounded concurrent `Telemetry.shutdown` plus POSIX
  `o11y.shutdownOnSignals`.
- `o11ytest`: hermetic test harness (`o11ytest.start`, `Recorder`,
  `expectSpan`, `expectLog`, `expectEvent`, `expectMetric`, `expectExemplar`,
  `expectCorrelated`, `expectConforms`, `expectTriangle`) plus in-process
  `HttpReceiver` (protobuf, OTLP/JSON, gzip, plain and TLS/mTLS) and
  `GrpcReceiver` (h2c and TLS/mTLS with ALPN `h2`).
- `o11yhttp`: zero-third-party-dependency instrumentation for
  `std.http.Server` and `std.http.Client` with route-aware span names,
  stable HTTP semantic conventions, `http.server.request.duration` and
  `http.client.request.duration` histograms with exemplars, W3C propagation
  with cross-origin redirect header stripping, `public_endpoint`,
  `ignore_paths` globs, `filter`, `Server-Timing`, and `canonical_line`.
- `o11yhttpz`: optional (`-Dhttpz=true`) middleware for `karlseguin/http.zig`
  with route metadata helpers (`route`, `extractRouteData`, `setRoute`),
  stable HTTP semconv spans and metrics with exemplars, `public_endpoint`,
  `ignore_paths`, `Server-Timing`, and `canonical_line`.
- `o11ypg`: optional (`-Dpg=true`) instrumentation wrapper for
  `karlseguin/pg.zig` pools and connections with parent-gated client spans,
  `db.client.operation.duration` with exemplars, PostgreSQL SQL sanitizer,
  SQLSTATE error codes, and observable pool metrics.
- `o11ysqlite`: optional (`-Dsqlite=true`) instrumentation wrapper for
  `vrischmann/zig-sqlite` databases and prepared statements with parent-gated
  client spans, `db.client.operation.duration` with exemplars, SQLite SQL
  sanitizer, and extended SQLite error codes.

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/zig/v0.1.0...HEAD
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/zig/v0.1.0
