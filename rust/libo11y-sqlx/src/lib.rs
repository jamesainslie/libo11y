//! OpenTelemetry instrumentation for [`sqlx`] following the libo11y
//! specification and OpenTelemetry database semantic conventions (1.41.0).
//!
//! Wrap a [`sqlx::Pool`] in [`O11yPool`] bound to a [`libo11y::Sdk`]:
//!
//! ```no_run
//! # async fn example(sdk: &libo11y::Sdk) -> Result<(), sqlx::Error> {
//! use libo11y_sqlx::O11yPool;
//! use sqlx::SqlitePool;
//!
//! let raw = SqlitePool::connect("sqlite::memory:").await?;
//! let pool = O11yPool::new(raw, sdk);
//!
//! let count: (i64,) = sqlx::query_as("SELECT 1")
//!     .fetch_one(&pool)
//!     .await?;
//! # let _ = count;
//! # Ok(())
//! # }
//! ```
//!
//! By default, client spans are emitted only when the current OpenTelemetry
//! context holds a valid parent span (so background queries never mint stray
//! root spans), while `db.client.operation.duration` is always recorded.

mod pool;
pub mod sqltext;
mod telemetry;

pub use pool::{O11yConnection, O11yPool, O11yTransaction};
pub use telemetry::{DURATION_BUCKETS, DbConfig, KnownDatabase, OTHER_SQL};
