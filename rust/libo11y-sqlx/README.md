# libo11y-sqlx

OpenTelemetry instrumentation for [`sqlx`](https://crates.io/crates/sqlx) following the libo11y specification and OpenTelemetry database semantic conventions (1.41.0).

## Features

- Dialect-aware SQL query sanitizer (`sqltext`) supporting `postgresql`, `sqlite`, `mysql`, and `mariadb`, removing literals and comments and bounding `db.query.text` at 4096 bytes on a UTF-8 boundary.
- Parented `SpanKind::Client` spans (only emitted under a valid active parent span by default, configurable via `DbConfig::record_unparented_spans`), with sanitized `db.query.text`, `db.system.name`, `db.operation.name`, `db.collection.name`, `db.namespace`, `server.address`, `server.port`, `db.response.status_code`, and `error.type` (never recording raw database error messages on span status).
- `db.client.operation.duration` histogram in seconds recorded through `Sdk::meter` so exemplars attach to the statement span.
- Connection pool observable metrics (`db.client.connection.count` by `idle`/`used` state and `db.client.connection.max`) bound to `Sdk::meter`.
- Implements `sqlx::Executor` on `&O11yPool<DB>` and `&mut O11yConnection<DB>` so standard `sqlx::query(...)` calls work unchanged.

## Minimum Supported Rust Version

`libo11y-sqlx` requires Rust 1.94 because `sqlx 0.9.0` requires Rust 1.94.
