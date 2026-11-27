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

[Unreleased]: https://github.com/jamesainslie/libo11y/commits/main
