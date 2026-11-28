# libo11y-sqlx

OpenTelemetry instrumentation for [`sqlx`](https://crates.io/crates/sqlx) following the libo11y specification and OpenTelemetry database semantic conventions (1.41.0).

## Features

- Dialect-aware SQL query sanitizer (`sqltext`) supporting `postgresql`, `sqlite`, `mysql`, and `mariadb`, removing literals and comments and bounding `db.query.text` at 4096 bytes on a UTF-8 boundary.
- Parented `SpanKind::Client` spans (only emitted under a valid active parent span by default, configurable via `DbConfig::with_record_unparented_spans`), with sanitized `db.query.text`, `db.system.name`, `db.operation.name`, `db.collection.name`, `db.namespace`, `server.address`, `server.port`, `db.response.status_code`, and `error.type` (never recording raw database error messages on span status).
- `db.client.operation.duration` histogram in seconds recorded through `Sdk::meter` so exemplars attach to the statement span.
- Connection pool observable metrics (`db.client.connection.count` by `idle`/`used` state and `db.client.connection.max`) bound to `Sdk::meter`.
- Implements `sqlx::Executor` on `&O11yPool<DB>`, `&mut O11yConnection<DB>`, and `&mut O11yTransaction<'_, DB>` so standard `sqlx::query(...)` calls work unchanged.
- A query or transaction call that is cancelled before it completes, for example under `tokio::time::timeout` or `tokio::select!`, still records its span and duration, with `error.type` `canceled`. A call that panics records `error.type` `panic`. A row stream dropped before its end is recorded as finished, with the first error it yielded or as a success.
- Dropping an uncommitted `O11yTransaction` relies on `sqlx::Transaction`'s asynchronous drop rollback without emitting a `ROLLBACK` span; call `tx.rollback().await` explicitly when you want a traced `ROLLBACK` span and duration metric.

## SQLx statement logging

`sqlx` 0.9 logs slow statements at `WARN` by default under the `sqlx::query` tracing target, including raw SQL in `db.statement` and `summary`. `libo11y`'s log and span layers strip `db.statement` and `summary` from `sqlx::query` events automatically, while keeping timing and row-count fields. If your application also installs another `tracing` subscriber alongside `libo11y`, call `ConnectOptions::disable_statement_logging()` on your `sqlx` connection options so raw SQL is never emitted to that subscriber either.

## Configuration

`O11yPool::new` infers `db.system.name` from the database type. Use `DbConfig` with `O11yPool::with_config` to set the rest:

```rust,ignore
use libo11y_sqlx::{DbConfig, O11yPool};

let config = DbConfig::for_database::<sqlx::Postgres>()
    .with_db_namespace("orders")
    .with_pool_name("primary")
    .with_server_address("db.internal")
    .with_server_port(5432);
let pool = O11yPool::with_config(raw_pool, &sdk, config);
```

`DbConfig` has private fields. Configure it with `DbConfig::new` or `DbConfig::for_database` and the setters: `with_db_system`, `with_db_namespace`, `with_pool_name`, `with_server_address`, `with_server_port`, `without_query_text`, and `with_record_unparented_spans`. Sanitized `db.query.text` is recorded by default for `postgresql`, `sqlite`, `mysql`, and `mariadb`.

## Limits of query text sanitizing

The sanitizer follows each server's default lexical rules. It cannot see the server's settings, and some settings change what counts as a literal. Under them part of a value can be kept in `db.query.text`:

- PostgreSQL with `standard_conforming_strings` off, and MySQL with `NO_BACKSLASH_ESCAPES`, read a backslash in `'...'` the other way.
- MySQL with `ANSI_QUOTES` reads `"..."` as an identifier, in which a backslash is an ordinary character.
- A MySQL connection in a multibyte character set such as GBK, SJIS, or Big5 can read a backslash byte as half of a character.
- MySQL skips a `/*!NNNNN ... */` body when its own version is lower than `NNNNN`, and MySQL, unlike MariaDB, skips every `/*M! ... */` body. The sanitizer lexes both bodies as SQL, as MariaDB does.
- For MySQL and MariaDB, the sanitizer removes a `/*+ ... */` optimizer hint as a comment that ends at the first `*/`, even inside a quoted hint argument.

If a server runs with one of these settings, turn query text off:

```rust,ignore
let config = DbConfig::for_database::<sqlx::MySql>().without_query_text();
```

Spans keep `db.operation.name` and `db.collection.name` without query text.

## Minimum Supported Rust Version

`libo11y-sqlx` requires Rust 1.94 because `sqlx 0.9.0` requires Rust 1.94.
