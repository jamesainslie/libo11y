# libo11y Rust

Opinionated, elegant observability for Rust services built on OpenTelemetry
(`0.33.1`) and `tracing`.

libo11y Rust ships as a Cargo workspace of 11 lockstep crates released together
from a `rust/vX.Y.Z` tag. One builder wires traces, metrics (with exemplars),
logs, W3C propagation, sensitivity redaction, application registries, and
bounded concurrent shutdown, while letting application code emit telemetry
through standard `tracing` and OpenTelemetry APIs.

## Crates

| Crate | Purpose |
|-------|---------|
| [`libo11y`](libo11y/) | Core SDK: `Sdk::builder()`, `setup()` / `build()`, identity and resource composition, sensitivity policy, application registries, `tracing` span/log layers, console JSON/text, events, wide records, startup canary, exemplar-aware meter provider and OTLP metric exporter, span redaction, W3C propagation, detached work (`Carrier`), child-process propagation (`proc`), `redact` re-export, process metrics, and bounded shutdown / signal handling |
| [`libo11y-spec`](libo11y-spec/) | Generated telemetry specification constants, closed enums, event/metric names, sensitivity tables, `SCHEMA_URL`, `SPEC_VERSION`, and `SEMCONV_VERSION` |
| [`libo11y-redact`](libo11y-redact/) | Capture-time redaction: `Secret<T>`, `Masked<T>`, the `Redact` trait, and `#[derive(Redact)]` re-export |
| [`libo11y-macros`](libo11y-macros/) | The `#[derive(Redact)]` procedural macro supporting `#[o11y(...)]` (`mask`, `redact`, `omit`, `confidential`, `secret`) |
| [`libo11y-test`](libo11y-test/) | Hermetic test harness (`Recorder`, `assert_conforms`, `assert_correlated`, `assert_triangle`) and in-process OTLP HTTP/gRPC receivers |
| [`libo11y-http`](libo11y-http/) | Tower HTTP server and client instrumentation layers (`ServerLayer`, `ClientLayer`), route-aware naming, `with_canonical_line`, `with_ignore_paths`, `with_public_endpoint`, and optional `axum` `MatchedPath` extraction |
| [`libo11y-reqwest`](libo11y-reqwest/) | `reqwest-middleware` client instrumentation (`O11yMiddleware`) with W3C propagation and `http.client.request.duration` exemplars |
| [`libo11y-tonic`](libo11y-tonic/) | Tower server and client instrumentation layers for `tonic` gRPC (`rpc.*` semconv 1.41.0, `with_ignore_health_checks`, `with_public_endpoint`) |
| [`libo11y-connect`](libo11y-connect/) | Connect RPC server and client instrumentation (`connectrpc` / `grpc`, canonical log lines, health checks, public endpoint) |
| [`libo11y-sqlx`](libo11y-sqlx/) | Instrumented `sqlx` executor wrapper (`O11yPool`, `O11yConnection`, `O11yTransaction`), parent-gated spans, SQL sanitizer for PostgreSQL/SQLite/MySQL/MariaDB, `db.client.operation.duration` with exemplars, and pool metrics |
| [`libo11y-cli`](libo11y-cli/) | The `libo11y` binary (`libo11y registry check FILE...`) for validating application attribute registries in CI |

## Quick start

Add `libo11y` (and any integration crates you need) to `Cargo.toml`:

```toml
[dependencies]
libo11y = "0.1"
libo11y-http = { version = "0.1", features = ["axum"] }
tracing = "0.1"

[dev-dependencies]
libo11y-test = "0.1"
```

Initialize telemetry once at startup with `Sdk::builder().setup()?` (or
`.build()?` for an independent, global-free handle):

```rust
use libo11y::{Environment, PiiMode, Sdk};
use libo11y::opentelemetry::KeyValue;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let sdk = Sdk::builder()
        .service_name("checkout")
        .environment(Environment::Production)
        .build_info(libo11y::build_info!())
        .app_registry_file("o11y-registry.yaml")
        .pii_mode(PiiMode::Drop)
        .setup()?;

    tracing::info_span!("checkout.place", order.id = "ord-42").in_scope(|| {
        tracing::info!(order.id = "ord-42", "order placed");

        sdk.event("checkout.order.placed", [KeyValue::new("order.id", "ord-42")]);
        sdk.meter("checkout")
            .u64_counter("checkout.orders")
            .build()
            .add(1, &[]);
    });

    sdk.shutdown_on_signals().await?;
    Ok(())
}
```

See [`examples/httpserver`](examples/httpserver/) for a complete, tested HTTP
service using `axum`, `o11y-registry.yaml`, `#[derive(Redact)]`,
`record_from_context`, and `libo11y-test`.

## `tracing` front door

Application code instruments with ordinary `tracing` spans and events:

- `Builder::setup()` installs one swappable libo11y global `tracing`
  dispatcher (plus the OpenTelemetry globals and optional `tracing-log` bridge).
  If another library already installed a global `tracing` subscriber, `setup()`
  returns `Error::ForeignTracingSubscriber`; call `.without_tracing_default()`
  and compose `sdk.tracing_layer()` into your existing subscriber instead.
- `Builder::build()` touches no process globals. Compose `sdk.tracing_layer()`
  or `sdk.subscriber()` explicitly (for example with
  `tracing::subscriber::with_default` or `WithSubscriber`).
- Span-event deduplication: every `tracing` event flows to the log pipeline
  (console JSON/text, OTLP logs, and extra `LogSink`s), while only `ERROR`
  events reach the span layer (with `with_error_events_to_status(true)` and
  `with_error_events_to_exceptions(false)`), preventing duplicate non-error
  span events.
- Diagnostics emitted by OpenTelemetry crates (`opentelemetry*` targets) are
  intercepted by libo11y's diagnostics layer and routed to the rate-limited
  error handler rather than your application log sinks.

## Compile-time `build_info!()`

Rust binaries do not carry a runtime VCS stamp like Go's `debug.ReadBuildInfo`.
Call `libo11y::build_info!()` in your application crate to capture
`CARGO_PKG_VERSION` and the vergen-standard `VERGEN_GIT_SHA`,
`VERGEN_GIT_COMMIT_TIMESTAMP`, and `VERGEN_GIT_DIRTY` compile-time values
(`option_env!`). They populate `service.version`, `vcs.ref.head.revision`,
`o11y.build.time`, and `o11y.build.modified` on the telemetry resource.

## Capture-time redaction

Key-based sensitivity classification drops known secret and PII keys across
every signal, while `libo11y::redact` protects sensitive fields before they
reach any formatter or serializer:

```rust
use libo11y::redact::{Masked, Redact, Secret};

#[derive(Redact)]
struct Customer {
    id: String,
    #[o11y(mask)]
    email: String,
    #[o11y(redact)]
    api_token: String,
    #[o11y(omit)]
    internal_notes: String,
}
```

`#[derive(Redact)]` generates `Debug`, `Display`, and `serde::Serialize`
implementations that always render the protected form (`XXXX...` for
`mask`/`confidential`, `REDACTED` for `redact`/`secret`, absent for `omit`).
Strictest protection wins through nested types, and unknown attributes fail
closed to `redact`. `Secret<T>` and `Masked<T>` wrap standalone values.

## Testing with `libo11y-test`

`libo11y_test::Recorder` builds a hermetic, in-memory `Sdk` (`without_otel_env`)
that touches no globals and is safe under parallel tests:

```rust
use libo11y_test::Recorder;

let rec = Recorder::start("checkout");
rec.in_scope(|| {
    let _span = tracing::info_span!("checkout.place").entered();
    tracing::info!(order.id = "ord-1", "order placed");
    rec.sdk()
        .meter("checkout")
        .u64_counter("orders.placed")
        .build()
        .add(1, &[]);
});

rec.assert_conforms();
rec.assert_correlated();
rec.assert_triangle("orders.placed");
```

`OtlpHttpReceiver` and `OtlpGrpcReceiver` provide in-process OTLP receivers for
wire-level verification.

## Feature flags

### `libo11y`

| Feature | Default | Description |
|---------|---------|-------------|
| `otlp-http` | on | OTLP over HTTP (`http/protobuf` and `http/json`) with gzip and rustls TLS |
| `otlp-grpc` | on | OTLP over gRPC via `tonic` with gzip and rustls TLS |
| `tokio` | on | Async shutdown (`shutdown_async`, `shutdown_with_timeout_async`) and `shutdown_on_signals` (Unix) |
| `log` | on | Bridges `log` crate records into the `tracing` subscriber via `tracing-log` |

### `libo11y-http`

| Feature | Default | Description |
|---------|---------|-------------|
| `axum` | off | Extracts route templates automatically from `axum::extract::MatchedPath` |

### `libo11y-sqlx`

| Feature | Default | Description |
|---------|---------|-------------|
| `sqlite` | on | Enables `sqlx/sqlite` support |
| `postgres` | off | Enables `sqlx/postgres` support |
| `mysql` | off | Enables `sqlx/mysql` support (MySQL and MariaDB) |

## CLI (`libo11y-cli`)

Validate application attribute registries in CI:

```sh
cargo install libo11y-cli
libo11y registry check o11y-registry.yaml
```

Exit codes match Go (`go/cmd/libo11y`) and TypeScript (`@libo11y/spec`): `0`
when all files are valid, `1` on policy violations or duplicate namespaces, `2`
on usage, read, or parse errors.

## MSRV policy

- Edition: Rust 2024
- Workspace MSRV: **1.88** (`rust-version = "1.88"`), verified in CI by
  `make rust-msrv`.
- Exception: **`libo11y-sqlx`** requires **Rust 1.94** because `sqlx 0.9.0`
  requires 1.94.
- CI and release builds run on pinned Rust `1.95.0`.

## Development

```sh
make rust-check           # fmt, clippy (-D warnings), test, doc (-D warnings)
make rust-msrv            # verify workspace (excluding libo11y-sqlx) on Rust 1.88
make rust-release-check   # verify lockstep versions, metadata, and packaging
```

See [docs/DESIGN.md](../docs/DESIGN.md), [docs/SPEC.md](../docs/SPEC.md),
[docs/CONVENTIONS.md](../docs/CONVENTIONS.md), and
[docs/PARITY.md](../docs/PARITY.md) for the cross-language contract and parity
matrix.
