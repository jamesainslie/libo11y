# Changelog

All notable changes to the libo11y Rust crates (`libo11y-spec`,
`libo11y-macros`, `libo11y-redact`, `libo11y`, `libo11y-test`, `libo11y-http`,
`libo11y-reqwest`, `libo11y-tonic`, `libo11y-connect`, `libo11y-sqlx`, and
`libo11y-cli`), which release in lockstep from a `rust/vX.Y.Z` tag, are
documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the crates adhere
to [Semantic Versioning](https://semver.org/).

Workspace MSRV is Rust 1.88 (Rust 1.94 for `libo11y-sqlx`).

## [Unreleased]

### Added

- `libo11y`: `Builder::span_level(tracing::Level)` to configure the minimum
  `tracing` span verbosity exported to OpenTelemetry (defaults to `INFO`).
- `libo11y-http`: `ServerLayer::with_server_timing()` emitting W3C
  `Server-Timing: traceparent;desc="..."` on HTML responses matching Go's
  `o11yhttp.WithServerTiming`.
- `libo11y-sqlx`: read-only getters on `DbConfig` (`db_system`, `db_namespace`,
  `pool_name`, `server_address`, `server_port`, `include_query_text`,
  `record_unparented_spans`).
- `libo11y-cli`: `run_os` accepting `OsStr` arguments so non-UTF-8 paths and
  arguments exit cleanly instead of panicking.

### Changed

- `libo11y-spec`: spec 1.3.0. `SPEC_VERSION` is `1.3.0` and `SCHEMA_URL` is
  `https://schemas.o11y.ing/libo11y/1.3.0`, so every resource carries the new
  schema URL. The new constants cover the `o11y.rum.view.summary` event and its
  attributes, the RUM span shape marker (`RumSpanShape`), the RUM detail
  attributes and `o11y.rum.app.update_id`, and the sensitivity table classifies
  `os.name` as public.
- `libo11y`: **Breaking**: `Error::NoServiceName`, `Error::NoEnvironment`,
  and `Error::PiiHashKey` display text now names Rust `Builder` methods
  (`Builder::service_name`, `Builder::environment`, `PiiMode::Hash`,
  `Builder::pii_hash_key`) instead of Go option names.
- `libo11y`: the `tracing` span layer defaults to exporting `INFO` and higher
  spans (filtering `DEBUG`/`TRACE` spans at callsite registration) and honors
  `opentelemetry::Context::is_current_telemetry_suppressed()` on both spans and
  logs.
- `libo11y-http`: **Breaking**: `ServerService::Response` wraps the inner
  response body in `ServerBody<B>` so server spans, `http.server.request.duration`,
  and canonical `o11y.request.summary` lines finish when the response body ends
  or drops instead of when headers are returned.
- `libo11y-tonic` and `libo11y-connect`: **Breaking**: server and client
  service error type parameters now require `'static` so transport and body
  errors can be classified by downcast (`tonic::Status`, `ConnectError`,
  connect, timeout, `h2`, `hyper`, and `std::io::Error`) instead of collapsing
  every error to a fixed status code.
- `libo11y-sqlx`: **Breaking**: `DbConfig` fields are now private behind its
  builder methods and read-only getters, so `include_query_text` can only be
  turned off via `DbConfig::without_query_text()`.
- `libo11y-cli`: **Breaking**: `libo11y registry check` validates each input
  file independently, matching Go's `go/cmd/libo11y` and TypeScript's
  `@libo11y/spec` without rejecting repeated namespaces across files.

### Removed

- `libo11y-sqlx`: **Breaking**: removed `DbConfig::with_query_text(bool)` so
  callers cannot force `db.query.text` on for dialects without a SQL sanitizer.

### Fixed

- `libo11y`: queue `Sdk::shutdown` behind an active `force_flush` under one
  shared deadline so in-flight flushes cannot race shutdown, open the
  failure-recording window before waiting on an active flush (with an RAII drop
  guard so panics never leak windows), and keep `o11y.telemetry.dropped`
  reporting strictly within the remaining shutdown deadline.
- `libo11y`: make libo11y-built OTLP headers (both ASCII and `*-bin` binary
  metadata) authoritative over ambient `OTEL_EXPORTER_OTLP_*HEADERS` on HTTP
  and gRPC exporters (including hermetic mode), validate malformed OTLP/HTTP
  endpoints at init across all three signals with sanitized error text, strip
  URL credentials from OTLP/HTTP metric transport errors, and deliver OTLP
  HTTP/gRPC metrics partial-success diagnostics directly to `ErrorHandler` even
  without a global `tracing` subscriber.
- `libo11y`: include instrumentation scope attributes in exemplar `ScopeKey`
  so meters with distinct scope attributes do not collide, and skip exemplar
  attachment on view-renamed streams so colliding original instrument names do
  not misattach.
- `libo11y`: correlate `tracing` events with explicit `parent: &span` to the
  named span's OpenTelemetry context and leave `parent: None` events
  uncorrelated, re-strip reserved keys (`trace_id`, `span_id`, and `event.name`
  for `Sdk::event`) after `AttrReplacer`, strip raw SQL (`db.statement`,
  `summary`) from `sqlx::query` tracing events on both logs and spans, and
  preserve the carrier link at index 0 in `start_linked_with` even when
  `configure` sets custom links.
- `libo11y-macros` and `libo11y-redact`: hide enum variant names when an enum
  or its container/field/caller floor is `mask` or `confidential`, and support
  recursive generic types (such as `Node<T>`) in `#[derive(Redact)]` without
  hitting overflow errors.
- `libo11y-http` and `libo11y-reqwest`: percent-decode query keys before
  redaction, redact `X-Amz-Security-Token`, `X-Amz-Credential`, and
  `X-Amz-Signature`, strip URL fragments from `url.full`, percent-decode
  request paths before `with_ignore_paths` matching (matching Go's `path.Match`
  for `/` inside `[...]`), clamp `url.scheme` to `http`/`https`, shorten
  `error.type` type names (mapping trait objects and boxed errors to `_OTHER`),
  and record canceled server and client futures with `error.type="canceled"`
  (and canonical status `499` on the server).
- `libo11y-tonic` and `libo11y-connect`: classify HTTP 200 gRPC responses
  missing `grpc-status` as `UNKNOWN`, collapse `UNIMPLEMENTED` server spans and
  `rpc.method` attributes to `_OTHER` (recorded once per span), map Connect
  HTTP 409/499/501 fallbacks to `Unknown`, and normalize canonical
  `http.request.method` values.
- `libo11y-sqlx`: record canceled and panicking query futures and panicking
  result streams as failed spans/metrics, fall back to `db.system.name` when
  both operation and collection are empty (matching Go), handle
  `Dialect::Other` in `collapse_in_lists`, and document SQL sanitizer limits,
  SQLx statement logging, and transaction drop behavior.
- `libo11y-cli` and `libo11y`: handle non-UTF-8 OS arguments without panicking,
  normalize uncommon OS read errors, verify all 46 `conformance/appregistry`
  `.want` outputs in CLI tests, and fail loudly if `conformance/` is missing
  inside a repository checkout.
- Packaging and docs: replace `LICENSE` symlinks in `libo11y-spec`,
  `libo11y-redact`, and `libo11y-macros` with regular files, remove stale
  unpublished notices from crate READMEs, compile workspace README snippets as
  doctests, and align `docs/PARITY.md` with the Rust implementation.

## [0.1.0] - 2026-11-27

### Added

- `libo11y-spec`: generated spec 1.2.0 attribute keys, closed enums, event and
  metric names, sensitivity and contract tables, `SCHEMA_URL`, `SPEC_VERSION`,
  and `SEMCONV_VERSION` (semconv v1.41.0), kept in sync via `make spec-drift`.
- `libo11y-macros` and `libo11y-redact`: capture-time redaction with
  `Secret<T>`, `Masked<T>`, the `Redact` trait, and `#[derive(Redact)]`
  supporting `#[o11y(mask | redact | omit | confidential | secret)]` across
  `Debug`, `Display`, `serde::Serialize`, and `tracing` fields recorded with
  `%` or `?` (strictest
  wins through nesting; unknown attributes fail closed to `redact`).
- `libo11y`: core SDK (`Sdk::builder()`, `Builder::setup()`, `Builder::build()`)
  on OpenTelemetry Rust 0.33.1 and `tracing` with swappable global subscriber
  guard (`Error::ForeignTracingSubscriber`, `Builder::without_tracing_default()`),
  `Sdk::tracing_layer()`, `Sdk::subscriber()`, optional `tracing-log` bridge,
  and typed `Error` variants matching Go's messages.
- `libo11y`: resource composition (`build_info!()`, host, runtime, container ID,
  `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME`, explicit options), tier-0
  identity enforcement (`service.name`, closed-set `deployment.environment.name`,
  `0.0.0-unknown` fallback), `service.instance.id` UUIDv5/v4 derivation, and
  single `SCHEMA_URL` stamping.
- `libo11y`: unified key-based sensitivity policy across all signals (secrets
  dropped, PII dropped by default, keyed HMAC-SHA256 tokens in `PiiMode::Hash`
  matching `conformance/vectors/pii-hash.json`, PII always dropped on metrics
  and exemplars, `o11y.schema.violations` self-metric) and strict YAML parser
  and validator for application attribute registries (`AppRegistry`, matching
  all `conformance/appregistry/` cases).
- `libo11y`: custom `tracing` log layer with JSON/text console formatting
  matching Go slog key order, OTLP log export, extra `LogSink`s,
  `with_attr_replacer`, runtime-adjustable `LevelHandle`, `with_force_emit` /
  `force_emit_context`, startup canary (`o11y.telemetry.configured`),
  `Sdk::effective_config()` with sanitized endpoints, registered event API
  (`Sdk::event`), and wide events (`Record`, `start_record`,
  `record_from_context`).
- `libo11y`: classifying, exemplar-aware `Libo11yMeterProvider`, aligned-bucket
  and fixed-size exemplar reservoirs (`ExemplarFilter` +
  `OTEL_METRICS_EXEMPLAR_FILTER`), wire-level OTLP metric exporter with HTTP
  (protobuf/JSON, gzip, TLS/mTLS), gRPC, console, and in-memory sinks, histogram
  bucket overrides, custom views, and Linux `/proc/self` `process.*` runtime
  metrics.
- `libo11y`: W3C Trace Context and Baggage propagation honoring
  `OTEL_PROPAGATORS` with inject-only baggage egress filter, hermetic mode
  (`Builder::without_otel_env()`), detached work (`detached::Carrier`,
  `capture`, `start_linked`), child-process propagation (`proc`), and bounded
  concurrent `Sdk::shutdown` / `force_flush` / `shutdown_on_signals`.
- `libo11y-test`: hermetic `Recorder` (`assert_conforms`, `assert_correlated`,
  `assert_triangle`, `spans`, `metrics`, `logs`, `exemplars`) and in-process
  `OtlpHttpReceiver` and `OtlpGrpcReceiver`.
- `libo11y-http`: Tower `ServerLayer` and `ClientLayer` following HTTP semantic
  conventions 1.41.0 with route-aware span names, `with_canonical_line`,
  `with_ignore_paths`, `with_public_endpoint`, panic recording, duration
  histograms with exemplars, and optional `axum` `MatchedPath` support.
- `libo11y-reqwest`: `reqwest-middleware` client instrumentation
  (`O11yMiddleware`) with W3C propagation and exemplar-linked duration metrics.
- `libo11y-tonic`: Tower server and client instrumentation layers for `tonic`
  gRPC following `rpc.*` semantic conventions 1.41.0 with health-check filtering
  and `with_public_endpoint`.
- `libo11y-connect`: Connect RPC server and client instrumentation with
  canonical lines, health-check filtering, and `with_public_endpoint`.
- `libo11y-sqlx`: `O11yPool`, `O11yConnection`, and `O11yTransaction` wrappers
  with parent-gated client spans, SQL sanitizer for PostgreSQL/SQLite/MySQL/
  MariaDB, `db.client.operation.duration` with exemplars, and pool metrics
  (MSRV 1.94).
- `libo11y-cli`: `libo11y registry check FILE...` CLI binary matching Go and
  TypeScript exit statuses (`0`/`1`/`2`) and output format, plus cross-file
  duplicate-namespace detection.
- `examples/httpserver`: tested end-to-end `axum` service demonstrating
  `o11y-registry.yaml`, `#[derive(Redact)]`, `build_info!()`, `ServerLayer`,
  `record_from_context`, and `libo11y-test`.

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/rust/v0.1.0...HEAD
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/rust/v0.1.0
